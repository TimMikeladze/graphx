/**
 * Native forks on bql.sh: two databases on one server branch through bql.sh's own fork, then
 * graphx trims the result in place. Every test compares against the row-copy fork of the same
 * source, so "native" is held to producing exactly the branch a copy would have.
 *
 * Starts an embedded bql.sh server in this process. Skips when `bql.sh` or the libsqlite3 it loads
 * is missing — build that once with `bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts`.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createBqlRemoteClient } from '../../src/core/bql.ts';
import { materializeConstraints } from '../../src/core/constraints.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { fork, type ForkResult } from '../../src/core/fork.ts';
import { Graph } from '../../src/core/graph.ts';
import { openMemoryDb } from '../../src/core/local.ts';
import { init } from '../../src/core/schema.ts';
import { stubEmbedder } from './harness.ts';

interface BqlServer {
	url: string;
	adminKey: string | null;
}
interface BqlInstance {
	serve(opts: { host: string; port: number }): Promise<BqlServer>;
	close(): Promise<void>;
}

/** An embedded bql.sh server, or the reason there is none. The specifier is a variable so the
 *  type checker never walks bql.sh's own TypeScript sources. */
async function startBql(): Promise<
	{ bql: BqlInstance; server: BqlServer; dir: string } | { skip: string }
> {
	const specifier = 'bql.sh';
	let mod: { Bql: { open(opts: { dir: string }): Promise<BqlInstance> } };
	try {
		mod = await import(specifier);
	} catch (error) {
		return { skip: `bql.sh is not installed (${String(error)})` };
	}
	const dir = await mkdtemp(join(tmpdir(), 'graphx-fork-bql-'));
	try {
		const bql = await mod.Bql.open({ dir });
		const server = await bql.serve({ host: '127.0.0.1', port: 0 });
		return { bql, server, dir };
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		return { skip: `bql.sh could not start (${String(error).split('\n')[0]})` };
	}
}

const started = await startBql();
const live = 'server' in started ? started : null;
if (!live) console.warn(`fork-bql.test.ts skipped: ${'skip' in started ? started.skip : ''}`);
const bqlTest = live ? test : test.skip;

afterAll(async () => {
	if (!live) return;
	await live.bql.close();
	await rm(live.dir, { recursive: true, force: true });
});

let serial = 0;
const names = new Map<DbClient, string>();
/** A client on a fresh, not yet created database of the test server. */
function bqlDb(opts: { foreignKeys?: boolean } = {}): DbClient {
	const database = `fork_${process.pid}_${serial++}`;
	const client = createBqlRemoteClient({
		url: live!.server.url,
		database,
		authToken: live!.server.adminKey ?? undefined,
		...opts,
	});
	names.set(client, database);
	return client;
}

/** The server's view of a database: lineage and settings. */
async function serverStat(client: DbClient): Promise<Record<string, unknown>> {
	const name = names.get(client)!;
	const res = await fetch(`${live!.server.url}/v1/db/${name}`, {
		headers: live!.server.adminKey ? { authorization: `Bearer ${live!.server.adminKey}` } : {},
	});
	return (await res.json()) as Record<string, unknown>;
}

const SCHEMA = defineGraphSchema({
	nodes: { light: z.object({ name: z.string(), green: z.number() }) },
	edges: {
		road: { from: 'light', to: 'light' },
		next: { from: 'light', to: 'light', single: true },
	},
});

const embedder = stubEmbedder((t) => [t.length, 1, 0, 0], { dim: 4 });
const tick = () => new Promise((r) => setTimeout(r, 5));

async function seeded(opts: { embed?: boolean } = {}) {
	const raw = bqlDb();
	await init(raw, opts.embed ? embedder : undefined);
	await materializeConstraints(raw, SCHEMA);
	const g = new Graph(raw, SCHEMA, {
		events: { outbox: true },
		...(opts.embed ? { embedder } : {}),
	});
	const a = await g.addNode({ type: 'light', data: { name: 'A', green: 30 }, body: 'alpha' });
	const b = await g.addNode({ type: 'light', data: { name: 'B', green: 40 }, body: 'beta' });
	const road = await g.addEdge({ rel: 'road', src: a.id, dst: b.id, weight: 7 });
	await g.addEdge({ rel: 'next', src: a.id, dst: b.id });
	return { raw, g, a, b, road };
}

/** Everything a fork reports except how it was made. */
function shape(r: ForkResult): Omit<ForkResult, 'method'> {
	const { method: _method, ...rest } = r;
	return rest;
}

bqlTest(
	'a full fork on one bql.sh server is native, and builds the branch a copy would',
	async () => {
		const { raw, g, a, b, road } = await seeded();
		const t1 = Date.now();
		await tick();
		await g.updateNode(a.id, { data: { name: 'A', green: 35 } });

		const nativeTarget = bqlDb();
		const native = await fork(raw, nativeTarget);
		const copy = await fork(raw, bqlDb(), { method: 'copy' });
		expect(native.method).toBe('native');
		expect(copy.method).toBe('copy');
		expect(shape(native)).toEqual(shape(copy));
		// a's update superseded its first row and recorded the closed part: 4 rows for 2 nodes
		expect(native).toMatchObject({ nodes: 2, nodeVersions: 4, edges: 2, constraints: 1 });

		const branch = new Graph(nativeTarget, SCHEMA);
		expect((await branch.getNode(a.id))?.data).toEqual({ name: 'A', green: 35 });
		expect((await branch.getNode(a.id, { asOf: t1 }))?.data).toEqual({ name: 'A', green: 30 });

		// The two diverge.
		await branch.updateNode(b.id, { data: { name: 'B', green: 60 } });
		await g.deleteEdge(road.id);
		expect((await g.getNode(b.id))?.data).toEqual({ name: 'B', green: 40 });
		expect((await branch.getNode(b.id))?.data).toEqual({ name: 'B', green: 60 });
		expect((await branch.listEdges({ rel: 'road' })).edges).toHaveLength(1);

		// The event log stays behind; bql.sh recorded the lineage; foreign keys are enforced.
		const outbox = async (c: DbClient) =>
			Number((await c.execute('SELECT count(*) AS n FROM graph_outbox')).rows[0]?.n);
		expect(await outbox(raw)).toBeGreaterThan(0);
		expect(await outbox(nativeTarget)).toBe(0);
		const s = await serverStat(nativeTarget);
		expect(s).toMatchObject({ foreignKeys: true, parent: names.get(raw) });
		await expect(
			nativeTarget.execute({
				sql: 'INSERT INTO node_versions (id, type, data, valid_from) VALUES (?, ?, ?, ?)',
				args: ['missing', 'light', '{}', 1],
			}),
		).rejects.toThrow(/FOREIGN KEY/i);
	},
);

bqlTest(
	'asOf: a native fork trims to the cut exactly as a copy does, vectors included',
	async () => {
		const { raw, g, a, b, road } = await seeded({ embed: true });
		await tick();
		const cut = Date.now();
		await tick();
		await g.updateNode(a.id, { data: { name: 'A', green: 99 }, body: 'a much longer body' });
		await g.deleteEdge(road.id);
		const late = await g.addNode({ type: 'light', data: { name: 'C', green: 1 }, body: 'gamma' });

		const nativeTarget = bqlDb();
		const native = await fork(raw, nativeTarget, { asOf: cut });
		const copy = await fork(raw, bqlDb(), { asOf: cut, method: 'copy' });
		expect(native.method).toBe('native');
		expect(shape(native)).toEqual(shape(copy));
		expect(native).toMatchObject({ nodes: 2, nodeVersions: 2, edges: 2, edgeVersions: 2 });
		expect(native.vectors).toBe(1);
		expect(native.needsEmbedding).toEqual([a.id]);

		const branch = new Graph(nativeTarget, SCHEMA, { embedder });
		expect((await branch.getNode(a.id))?.data).toEqual({ name: 'A', green: 30 });
		expect((await branch.getNode(b.id))?.data).toEqual({ name: 'B', green: 40 });
		expect(await branch.getNode(late.id)).toBeNull();
		expect((await branch.listEdges({ rel: 'road' })).edges.map((e) => e.id)).toEqual([road.id]);

		// Full-text search sees the reopened version and nothing the cut left behind.
		expect((await branch.listNodes({ type: 'light', q: 'alpha' })).nodes.map((n) => n.id)).toEqual([
			a.id,
		]);
		expect((await branch.listNodes({ type: 'light', q: 'longer' })).nodes).toHaveLength(0);
		expect((await branch.listNodes({ type: 'light', q: 'gamma' })).nodes).toHaveLength(0);

		// The reopened version is live and writable, and the single-valued rel still holds.
		await branch.updateNode(a.id, { data: { name: 'A', green: 45 } });
		expect((await branch.getNode(a.id))?.data).toEqual({ name: 'A', green: 45 });

		// Graph.fork re-embeds what the cut left without a valid vector.
		const embedded = await g.fork(bqlDb(), { asOf: cut });
		expect(await embedded.embeddingReport()).toMatchObject({
			embedded: 2,
			unembedded: 0,
			stale: 0,
		});
	},
);

bqlTest('falls back to a copy when the target already exists or is another backend', async () => {
	const { raw, a } = await seeded();

	const existing = bqlDb();
	await init(existing); // created on the server, empty
	const intoExisting = await fork(raw, existing);
	expect(intoExisting.method).toBe('copy');
	expect((await new Graph(existing, SCHEMA).getNode(a.id))?.data).toEqual({ name: 'A', green: 30 });

	const local = await openMemoryDb();
	try {
		const intoLocal = await fork(raw, local);
		expect(intoLocal.method).toBe('copy');
		expect((await new Graph(local, SCHEMA).getNode(a.id))?.data).toEqual({ name: 'A', green: 30 });
	} finally {
		await local.close();
	}
});

bqlTest('a trim that fails discards the branch, and the target client works again', async () => {
	const { raw, a } = await seeded();
	// Break the trim: the branch inherits a database whose event tables are gone.
	await raw.execute('DROP TABLE archival_state');
	const target = bqlDb();

	await expect(fork(raw, target)).rejects.toThrow(/archival_state/);
	const gone = await fetch(`${live!.server.url}/v1/db/${names.get(target)}`, {
		headers: live!.server.adminKey ? { authorization: `Bearer ${live!.server.adminKey}` } : {},
	});
	expect(gone.status).toBe(404);

	// The client provisions its database again on first use, so a copy into it succeeds.
	const copied = await fork(raw, target, { method: 'copy' });
	expect(copied.method).toBe('copy');
	expect((await new Graph(target, SCHEMA).getNode(a.id))?.data).toEqual({ name: 'A', green: 30 });
});

bqlTest('refuses two clients on the same bql.sh database', async () => {
	const { raw } = await seeded();
	const twin = createBqlRemoteClient({
		url: live!.server.url,
		database: names.get(raw)!,
		authToken: live!.server.adminKey ?? undefined,
	});
	await expect(fork(raw, twin)).rejects.toThrow(/same bql.sh database/);
});

bqlTest('the target client decides foreign keys, whatever the source had', async () => {
	// A source left at the node default (off): its branch inherits that, and the target wants on.
	const source = bqlDb({ foreignKeys: false });
	await init(source);
	await new Graph(source, SCHEMA).addNode({ type: 'light', data: { name: 'A', green: 30 } });
	expect((await serverStat(source)).foreignKeys).toBeNull();

	const target = bqlDb();
	expect((await fork(source, target)).method).toBe('native');
	expect((await serverStat(target)).foreignKeys).toBe(true);
});

bqlTest(
	'a recorded-time cut on one bql.sh server is native, and builds the branch a copy would',
	async () => {
		const { raw, g, a } = await seeded();
		await tick();
		const before = Date.now();
		await tick();
		await g.correctNode(
			a.id,
			{ data: { name: 'A', green: 31 } },
			{ validFrom: Date.UTC(2000, 0, 1) },
		);
		for (const cut of [{ recordedAsOf: before }, { asOf: Date.now(), recordedAsOf: before }]) {
			const nativeTarget = bqlDb();
			const native = await fork(raw, nativeTarget, cut);
			const copy = await fork(raw, bqlDb(), { ...cut, method: 'copy' });
			expect(native.method).toBe('native');
			expect(shape(native)).toEqual(shape(copy));
			const branch = new Graph(nativeTarget, SCHEMA);
			expect((await branch.getNode(a.id))?.data).toEqual({ name: 'A', green: 30 });
		}
	},
);
