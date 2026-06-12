import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { afterAll, expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { materializeConstraints } from '../src/constraints.ts';
import { FOREVER } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';

// P14 — the §19.1 write-correctness proof. The conditional-close + retry is ALREADY
// implemented (P6); this proves the invariant under genuine contention: N racing
// writers on SEPARATE connections to the same file DB serialize on the write lock
// (busy_timeout) so the version chain is contiguous and non-overlapping — never two
// live versions, never two overlapping [valid_from, valid_to). The same proof covers
// the new single-valued edge-cardinality close path.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string(), v: z.number().optional() }) },
	edges: {
		best_friend: { from: 'person', to: 'person', single: true },
		knows: { from: 'person', to: 'person' },
	},
});

const tmpFiles: string[] = [];
function freshFile(): string {
	const file = join(tmpdir(), `graphx-p14race-${ulid()}.db`);
	tmpFiles.push(file);
	return file;
}
afterAll(() => {
	for (const f of tmpFiles) {
		for (const suffix of ['', '-wal', '-shm']) {
			try {
				rmSync(f + suffix);
			} catch {
				// best-effort
			}
		}
	}
});

interface Interval {
	valid_from: number;
	valid_to: number;
}

/** All version intervals for `id`, ascending by valid_from. */
async function intervals(client: Client, id: string): Promise<Interval[]> {
	const r = await client.execute({
		sql: 'SELECT valid_from, valid_to FROM node_versions WHERE id = ? ORDER BY valid_from, valid_to',
		args: [id],
	});
	return r.rows.map((x) => ({ valid_from: Number(x.valid_from), valid_to: Number(x.valid_to) }));
}

/** Assert a half-open interval set is contiguous, non-overlapping, single-open, non-zero-width. */
function assertNonOverlapping(rows: Interval[]): void {
	const live = rows.filter((r) => r.valid_to === FOREVER);
	expect(live.length).toBe(1); // exactly one live version
	for (const r of rows) {
		// M6: every version is a REAL interval — no zero-width [T,T) (invisible to as-of)
		expect(r.valid_to).toBeGreaterThan(r.valid_from);
	}
	for (let i = 0; i < rows.length - 1; i++) {
		const a = rows[i] as Interval;
		const b = rows[i + 1] as Interval;
		// no overlap: a closes at or before b opens (half-open [from,to))
		expect(a.valid_to).toBeLessThanOrEqual(b.valid_from);
		// contiguous chain: a closed version hands off exactly to the next
		expect(a.valid_to).toBe(b.valid_from);
	}
}

test('P14 race: N concurrent updateNode never create overlapping intervals', async () => {
	const file = freshFile();
	const setup = createClient({ url: `file:${file}` });
	await init(setup, 4);
	const seed = await new Graph(setup, SCHEMA).addNode({ kind: 'person', props: { name: 'race' } });

	// N writers, each on its OWN connection → genuine write-lock contention.
	const N = 8;
	const clients = Array.from({ length: N }, () => createClient({ url: `file:${file}` }));
	const graphs = clients.map((c) => new Graph(c, SCHEMA));

	const results = await Promise.allSettled(
		graphs.map((g, i) => g.updateNode(seed.id, { props: { v: i } })),
	);
	// every writer succeeded (busy_timeout serializes; the close always affects 1 row)
	for (const r of results) expect(r.status).toBe('fulfilled');

	const rows = await intervals(setup, seed.id);
	expect(rows.length).toBe(N + 1); // original + one new version per writer
	assertNonOverlapping(rows);

	setup.close();
	for (const c of clients) c.close();
});

test('P14 race (F2): updateNode never creates an inverted/zero-width interval when the live valid_from leads the clock', async () => {
	const file = freshFile();
	const client = createClient({ url: `file:${file}` });
	await init(client, 4);
	const g = new Graph(client, SCHEMA);
	const n = await g.addNode({ kind: 'person', props: { name: 'x' } });
	// Force the live version's valid_from far into the future — simulates a cross-instance
	// writer whose monotonic clock ran ahead, so this instance's now() is BEHIND the
	// predecessor's valid_from. M6 must still produce a real interval.
	const future = Date.now() + 5_000_000;
	await client.execute({
		sql: 'UPDATE node_versions SET valid_from = ? WHERE id = ? AND valid_to = ?',
		args: [future, n.id, FOREVER],
	});

	await g.updateNode(n.id, { props: { name: 'y' } });
	const rows = await intervals(client, n.id);
	const closed = rows.filter((r) => r.valid_to !== FOREVER);
	expect(closed.length).toBe(1);
	// the closed predecessor must be a real, non-zero, non-inverted [valid_from, valid_to)
	expect((closed[0] as Interval).valid_to).toBeGreaterThan((closed[0] as Interval).valid_from);
	client.close();
});

test('P14 race (F1): a contended addNode survives SQLITE_BUSY via the same retry envelope', async () => {
	const file = freshFile();
	const setup = createClient({ url: `file:${file}` });
	await init(setup, 4);

	const clientA = createClient({ url: `file:${file}` });
	const gA = new Graph(clientA, SCHEMA);
	// An interactive tx detaches/recreates A's connection, dropping busy_timeout to 0 →
	// A's next batch BEGIN IMMEDIATE fails fast on a held lock instead of waiting.
	const t0 = await clientA.transaction('write');
	await t0.commit();

	// B holds the write lock; released after a beat.
	const clientB = createClient({ url: `file:${file}` });
	const txB = await clientB.transaction('write');
	await txB.execute({ sql: "INSERT INTO node_identity (id) VALUES ('lock')" });

	const p = gA.addNode({ kind: 'person', props: { name: 'survivor' } });
	await new Promise((r) => setTimeout(r, 120));
	await txB.rollback();

	// Without the batch retry envelope this rejects with SQLITE_BUSY in ~1ms.
	const node = await p;
	expect(node.id.length).toBe(26);
	const r = await setup.execute({ sql: 'SELECT 1 FROM nodes WHERE id = ?', args: [node.id] });
	expect(r.rows.length).toBe(1); // it really persisted, not lost

	setup.close();
	clientA.close();
	clientB.close();
});

test('P14 race (F2-edge): concurrent single-valued addEdge never leave a zero-width/inverted closed interval', async () => {
	const file = freshFile();
	const setup = createClient({ url: `file:${file}` });
	await init(setup, 4);
	await materializeConstraints(setup, SCHEMA);
	const g0 = new Graph(setup, SCHEMA);
	const src = await g0.addNode({ kind: 'person', props: { name: 'src' } });
	const dsts = await Promise.all(
		Array.from({ length: 16 }, (_, i) => g0.addNode({ kind: 'person', props: { name: `d${i}` } })),
	);
	const N = dsts.length;
	const clients = Array.from({ length: N }, () => createClient({ url: `file:${file}` }));
	const graphs = clients.map((c) => new Graph(c, SCHEMA));

	const results = await Promise.allSettled(
		graphs.map((g, i) =>
			g.addEdge({ rel: 'best_friend', src: src.id, dst: (dsts[i] as { id: string }).id }),
		),
	);
	for (const r of results) expect(r.status).toBe('fulfilled');

	const rows = await setup.execute({
		sql: 'SELECT valid_from, valid_to FROM edge_versions WHERE src = ? AND rel = ?',
		args: [src.id, 'best_friend'],
	});
	// every version (live + every closed predecessor) must be a real, non-zero interval
	for (const row of rows.rows) {
		expect(Number(row.valid_to)).toBeGreaterThan(Number(row.valid_from));
	}
	expect(rows.rows.filter((r) => Number(r.valid_to) === FOREVER).length).toBe(1);

	setup.close();
	for (const c of clients) c.close();
});

test('P14 race: N concurrent single-valued addEdge converge to exactly one live edge', async () => {
	const file = freshFile();
	const setup = createClient({ url: `file:${file}` });
	await init(setup, 4);
	await materializeConstraints(setup, SCHEMA); // partial unique index on (src) for best_friend
	const g0 = new Graph(setup, SCHEMA);
	const src = await g0.addNode({ kind: 'person', props: { name: 'src' } });
	const dsts = await Promise.all(
		Array.from({ length: 8 }, (_, i) => g0.addNode({ kind: 'person', props: { name: `d${i}` } })),
	);

	const N = dsts.length;
	const clients = Array.from({ length: N }, () => createClient({ url: `file:${file}` }));
	const graphs = clients.map((c) => new Graph(c, SCHEMA));

	const results = await Promise.allSettled(
		graphs.map((g, i) =>
			g.addEdge({ rel: 'best_friend', src: src.id, dst: (dsts[i] as { id: string }).id }),
		),
	);
	for (const r of results) expect(r.status).toBe('fulfilled');

	// exactly one live best_friend edge from src; total versions = N (one per addEdge,
	// closes don't add rows), so N-1 are closed.
	const live = await setup.execute({
		sql: 'SELECT COUNT(*) AS c FROM edge_versions WHERE src = ? AND rel = ? AND valid_to = ?',
		args: [src.id, 'best_friend', FOREVER],
	});
	expect(Number(live.rows[0]?.c)).toBe(1);
	const total = await setup.execute({
		sql: 'SELECT COUNT(*) AS c FROM edge_versions WHERE src = ? AND rel = ?',
		args: [src.id, 'best_friend'],
	});
	expect(Number(total.rows[0]?.c)).toBe(N);

	setup.close();
	for (const c of clients) c.close();
});
