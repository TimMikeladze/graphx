import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { materializeConstraints } from '../src/constraints.ts';
import { FOREVER } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { createDuckClient } from '../src/duck.ts';
import { Graph } from '../src/graph.ts';
import { MemoryObjectStore } from '../src/objstore/memory.ts';
import { init } from '../src/schema.ts';
import { duckdbOnly, makeTestDb, sharedWriterOnly } from './harness.ts';

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

const teardowns: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const t of teardowns) await t();
});

interface Interval {
	valid_from: number;
	valid_to: number;
}

/** All version intervals for `id`, ascending by valid_from. */
async function intervals(client: DbClient, id: string): Promise<Interval[]> {
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

sharedWriterOnly('P14 race: N concurrent updateNode never create overlapping intervals', async () => {
	const { client: setup, sibling, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(setup, 4);
	const seed = await new Graph(setup, SCHEMA).addNode({ type: 'person', data: { name: 'race' } });

	// N writers, each on its OWN connection → genuine write-lock contention.
	const N = 8;
	const clients = Array.from({ length: N }, () => (sibling as () => DbClient)());
	const graphs = clients.map((c) => new Graph(c, SCHEMA));

	const results = await Promise.allSettled(
		graphs.map((g, i) => g.updateNode(seed.id, { data: { v: i } })),
	);
	// every writer succeeded (busy_timeout serializes; the close always affects 1 row)
	for (const r of results) expect(r.status).toBe('fulfilled');

	const rows = await intervals(setup, seed.id);
	expect(rows.length).toBe(N + 1); // original + one new version per writer
	assertNonOverlapping(rows);
});

test('P14 race (F2): updateNode never creates an inverted/zero-width interval when the live valid_from leads the clock', async () => {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, 4);
	const g = new Graph(client, SCHEMA);
	const n = await g.addNode({ type: 'person', data: { name: 'x' } });
	// Force the live version's valid_from far into the future — simulates a cross-instance
	// writer whose monotonic clock ran ahead, so this instance's now() is BEHIND the
	// predecessor's valid_from. M6 must still produce a real interval.
	const future = Date.now() + 5_000_000;
	await client.execute({
		sql: 'UPDATE node_versions SET valid_from = ? WHERE id = ? AND valid_to = ?',
		args: [future, n.id, FOREVER],
	});

	await g.updateNode(n.id, { data: { name: 'y' } });
	const rows = await intervals(client, n.id);
	const closed = rows.filter((r) => r.valid_to !== FOREVER);
	expect(closed.length).toBe(1);
	// the closed predecessor must be a real, non-zero, non-inverted [valid_from, valid_to)
	expect((closed[0] as Interval).valid_to).toBeGreaterThan((closed[0] as Interval).valid_from);
});

sharedWriterOnly('P14 race (F1): a contended addNode survives SQLITE_BUSY via the same retry envelope', async () => {
	const { client: setup, sibling, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(setup, 4);

	const clientA = (sibling as () => DbClient)();
	const gA = new Graph(clientA, SCHEMA);
	// An interactive tx detaches/recreates A's connection, dropping busy_timeout to 0 →
	// A's next batch BEGIN IMMEDIATE fails fast on a held lock instead of waiting.
	const t0 = await clientA.transaction('write');
	await t0.commit();

	// B holds the write lock; released after a beat.
	const clientB = (sibling as () => DbClient)();
	const txB = await clientB.transaction('write');
	await txB.execute({ sql: "INSERT INTO node_identity (id) VALUES ('lock')" });

	const p = gA.addNode({ type: 'person', data: { name: 'survivor' } });
	await new Promise((r) => setTimeout(r, 120));
	await txB.rollback();

	// Without the batch retry envelope this rejects with SQLITE_BUSY in ~1ms.
	const node = await p;
	expect(node.id.length).toBe(26);
	const r = await setup.execute({ sql: 'SELECT 1 FROM nodes WHERE id = ?', args: [node.id] });
	expect(r.rows.length).toBe(1); // it really persisted, not lost
});

sharedWriterOnly('P14 race (F2-edge): concurrent single-valued addEdge never leave a zero-width/inverted closed interval', async () => {
	const { client: setup, sibling, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(setup, 4);
	await materializeConstraints(setup, SCHEMA);
	const g0 = new Graph(setup, SCHEMA);
	const src = await g0.addNode({ type: 'person', data: { name: 'src' } });
	const dsts = await Promise.all(
		Array.from({ length: 16 }, (_, i) => g0.addNode({ type: 'person', data: { name: `d${i}` } })),
	);
	const N = dsts.length;
	const clients = Array.from({ length: N }, () => (sibling as () => DbClient)());
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
});

sharedWriterOnly('P14 race: N concurrent single-valued addEdge converge to exactly one live edge', async () => {
	const { client: setup, sibling, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(setup, 4);
	await materializeConstraints(setup, SCHEMA); // partial unique index on (src) for best_friend
	const g0 = new Graph(setup, SCHEMA);
	const src = await g0.addNode({ type: 'person', data: { name: 'src' } });
	const dsts = await Promise.all(
		Array.from({ length: 8 }, (_, i) => g0.addNode({ type: 'person', data: { name: `d${i}` } })),
	);

	const N = dsts.length;
	const clients = Array.from({ length: N }, () => (sibling as () => DbClient)());
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
});

// --- DuckDB on object storage -------------------------------------------------------
// The four tests above prove the §19.1 invariants through write-lock contention, which
// DuckDB does not have. It reaches the same invariants two other ways, and each gets a
// test here: in-process, the client's write mutex serializes every mutation; across
// processes, the manifest CAS decides who owns the next snapshot number.

duckdbOnly('P14 duckdb: N concurrent updateNode serialize into one contiguous chain', async () => {
	const store = new MemoryObjectStore();
	const c = createDuckClient({ store, cacheDir: mkdtempSync(join(tmpdir(), 'graphx-p14-')) });
	const g = new Graph(c, SCHEMA);
	const seed = await g.addNode({ type: 'person', data: { name: 'race' } });

	// One client, N concurrent writers — the mutex is what makes the conditional close a
	// real compare-and-swap here, so every writer lands and none overlaps.
	const N = 8;
	const results = await Promise.allSettled(
		Array.from({ length: N }, (_, i) => g.updateNode(seed.id, { data: { v: i } })),
	);
	for (const r of results) expect(r.status).toBe('fulfilled');

	const rows = await intervals(c, seed.id);
	expect(rows.length).toBe(N + 1); // original + one new version per writer
	assertNonOverlapping(rows);
	await c.end();
});

duckdbOnly('P14 duckdb: N concurrent single-valued addEdge converge to exactly one live edge', async () => {
	const store = new MemoryObjectStore();
	const c = createDuckClient({ store, cacheDir: mkdtempSync(join(tmpdir(), 'graphx-p14-')) });
	const g = new Graph(c, SCHEMA);
	const src = await g.addNode({ type: 'person', data: { name: 'src' } });
	const dsts = await Promise.all(
		Array.from({ length: 8 }, (_, i) => g.addNode({ type: 'person', data: { name: `d${i}` } })),
	);
	const N = dsts.length;

	const results = await Promise.allSettled(
		dsts.map((d) => g.addEdge({ rel: 'best_friend', src: src.id, dst: d.id })),
	);
	for (const r of results) expect(r.status).toBe('fulfilled');

	const rows = await c.execute({
		sql: 'SELECT valid_from, valid_to FROM edge_versions WHERE src = ? AND rel = ?',
		args: [src.id, 'best_friend'],
	});
	// Every version is a real, non-zero interval, and exactly one is still open — the same
	// assertion the libSQL test makes, reached through the mutex instead of the write lock.
	for (const row of rows.rows) {
		expect(Number(row.valid_to)).toBeGreaterThan(Number(row.valid_from));
	}
	expect(rows.rows.filter((r) => Number(r.valid_to) === FOREVER).length).toBe(1);
	expect(rows.rows.length).toBe(N);
	await c.end();
});

duckdbOnly('P14 duckdb: two writers racing one snapshot number never both win', async () => {
	const store = new MemoryObjectStore();
	const dir = (): string => mkdtempSync(join(tmpdir(), 'graphx-p14-'));
	const a = createDuckClient({ store, cacheDir: dir() });
	const b = createDuckClient({ store, cacheDir: dir() });
	const [ga, gb] = [new Graph(a, SCHEMA), new Graph(b, SCHEMA)];

	const settled = await Promise.allSettled([
		ga.addNode({ type: 'person', data: { name: 'a' } }),
		gb.addNode({ type: 'person', data: { name: 'b' } }),
	]);
	// Separate clients are separate local databases, so the loser's rebase would replace the
	// winner's rows rather than merge with them. It refuses instead — a lost write the
	// caller is told about beats a silently discarded one.
	expect(settled.filter((r) => r.status === 'fulfilled').length).toBe(1);
	expect(settled.filter((r) => r.status === 'rejected').length).toBe(1);
	expect((await store.list('snapshots/')).length).toBe(1);

	const reader = createDuckClient({ store, cacheDir: dir() });
	await reader.open();
	expect((await reader.execute('SELECT count(*) AS n FROM node_identity')).rows[0]?.n).toBe(1);
	await reader.end();
	await a.end();
	await b.end();
});
