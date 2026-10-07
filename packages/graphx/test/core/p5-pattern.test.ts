import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { Graph } from '../../src/core/graph.ts';
import { match } from '../../src/core/pattern.ts';
import { init } from '../../src/core/schema.ts';
import { makeTestDb } from './harness.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

// P5 — PatternBuilder (§8). Verifies the fluent builder compiles to a valid SQL
// JOIN chain, that param order matches textual placeholder order (acceptance §16 —
// the make-or-break), that the variable-length segment emits a recursive CTE,
// that `.asOf` swaps the now-views for the *_versions tables, and that `.run()`
// returns rows typed/shaped per alias against a real :memory: graph.

const SCHEMA = defineGraphSchema({
	nodes: {
		person: z.object({ name: z.string() }),
		device: z.object({ type: z.string() }),
		tag: z.object({ label: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device' },
		knows: { from: 'person', to: 'person' },
		tagged: { from: 'device', to: 'tag' },
	},
});

type Schema = typeof SCHEMA;

async function freshGraph(): Promise<{ client: DbClient; g: Graph<Schema> }> {
	const client = makeTestDb().client;
	await init(client, hashEmbed(4));
	return { client, g: new Graph(client, SCHEMA) };
}

/** Count '?' placeholders in SQL. */
function placeholderCount(sql: string): number {
	return (sql.match(/\?/g) ?? []).length;
}

test('P5: 3-node fixed pattern compiles to a valid JOIN chain', () => {
	const { sql, args } = match(SCHEMA)
		.node('a', 'person')
		.out('owns')
		.node('b', 'device')
		.out('tagged')
		.node('c', 'tag')
		.toSQL();

	// Structure: FROM <nodes> a, JOIN edges e1 ... JOIN nodes b ... JOIN edges e2 ... JOIN nodes c
	expect(sql).toContain('FROM nodes a');
	expect(sql).toContain('JOIN edges e1 ON e1.src = a.id AND e1.rel = ?');
	expect(sql).toContain('JOIN nodes b ON b.id = e1.dst');
	expect(sql).toContain('JOIN edges e2 ON e2.src = b.id AND e2.rel = ?');
	expect(sql).toContain('JOIN nodes c ON c.id = e2.dst');

	// Rel and node-type placeholders in textual order; a0's type renders last (the WHERE).
	expect(sql).toContain('b.type = ?');
	expect(placeholderCount(sql)).toBe(args.length);
	expect(args).toEqual(['owns', 'device', 'tagged', 'tag', 'person']);
});

test('P5: placeholder count === args.length (with where filters)', () => {
	const { sql, args } = match(SCHEMA)
		.node('a', 'person')
		.where('a', 'name', 'ada')
		.out('owns')
		.node('b', 'device')
		.where('b', 'type', 'router')
		.toSQL();

	expect(placeholderCount(sql)).toBe(args.length);
	// Textual order: rel(owns) and b's type + where(type) in the JOIN, then a0's type and
	// where(name) in the trailing WHERE clause (rendered last).
	expect(args).toEqual(['owns', 'device', 'router', 'person', 'ada']);
	expect(sql).toContain("json_extract(a.data, '$.name') = ?");
	expect(sql).toContain("json_extract(b.data, '$.type') = ?");
});

test('P5: PARAM ORDER — .where + .asOf line up positionally with placeholders (§16)', () => {
	const T = 1000;
	const { sql, args } = match(SCHEMA)
		.node('a', 'person')
		.where('a', 'name', 'ada')
		.out('owns')
		.node('b', 'device')
		.where('b', 'type', 'router')
		.asOf(T)
		.toSQL();

	// asOf -> *_versions sources, with the half-open temporal predicate per alias.
	expect(sql).toContain('FROM node_versions a');
	expect(sql).toContain('JOIN edge_versions e1');
	expect(sql).toContain('JOIN node_versions b');

	// Textual order of placeholders (a0's predicates render in the trailing WHERE,
	// which is textually LAST — so its args are appended after the JOIN-chain args):
	//   e1.rel = ?                          -> 'owns'
	//   e1.valid_from <= ?, ? < e1.valid_to -> T, T
	//   b.valid_from <= ?, ? < b.valid_to   -> T, T
	//   b.type = ?                          -> 'device'
	//   json_extract(b.data,'$.type') = ?  -> 'router'
	//   a.valid_from <= ?, ? < a.valid_to   -> T, T   (WHERE)
	//   a.type = ?                          -> 'person' (WHERE)
	//   json_extract(a.data,'$.name') = ?  -> 'ada'  (WHERE)
	expect(args).toEqual(['owns', T, T, T, T, 'device', 'router', T, T, 'person', 'ada']);
	expect(placeholderCount(sql)).toBe(args.length);

	// Cross-check textual placeholder order matches the arg order above.
	const idxRel = sql.indexOf('e1.rel = ?');
	const idxType = sql.indexOf("json_extract(b.data, '$.type')");
	const idxName = sql.indexOf("json_extract(a.data, '$.name')");
	expect(idxRel).toBeGreaterThan(-1);
	expect(idxType).toBeGreaterThan(idxRel); // rel placeholder before b.type placeholder
	expect(idxName).toBeGreaterThan(idxType); // b.type (a JOIN cond) before a.name (the WHERE)
});

test('P5: asOf switches sources to *_versions; without asOf targets the views', () => {
	const withAsOf = match(SCHEMA)
		.node('a', 'person')
		.out('owns')
		.node('b', 'device')
		.asOf(500)
		.toSQL();
	expect(withAsOf.sql).toContain('node_versions');
	expect(withAsOf.sql).toContain('edge_versions');
	expect(withAsOf.sql).not.toContain('FROM nodes ');
	expect(withAsOf.sql).toContain('valid_from <= ?');

	const noAsOf = match(SCHEMA).node('a', 'person').out('owns').node('b', 'device').toSQL();
	expect(noAsOf.sql).toContain('FROM nodes a');
	expect(noAsOf.sql).toContain('JOIN edges e1');
	expect(noAsOf.sql).not.toContain('node_versions');
	expect(noAsOf.sql).not.toContain('edge_versions');
	expect(noAsOf.sql).not.toContain('valid_from');
});

test('P5: in/both directions compile correctly', () => {
	const inSql = match(SCHEMA).node('b', 'device').in('owns').node('a', 'person').toSQL();
	expect(inSql.sql).toContain('JOIN edges e1 ON e1.dst = b.id AND e1.rel = ?');
	expect(inSql.sql).toContain('JOIN nodes a ON a.id = e1.src');

	const bothSql = match(SCHEMA).node('a', 'person').both('knows').node('b', 'person').toSQL();
	expect(bothSql.sql).toContain('(e1.src = a.id OR e1.dst = a.id)');
	expect(bothSql.sql).toContain('CASE WHEN e1.src = a.id THEN e1.dst ELSE e1.src END');
});

test('P5: variable-length segment emits a recursive CTE with a depth guard', () => {
	const { sql, args } = match(SCHEMA)
		.node('a', 'person')
		.rel('knows', { min: 1, max: 3 })
		.node('b', 'person')
		.toSQL();

	expect(sql).toContain('WITH RECURSIVE');
	expect(sql).toContain('walk.depth < 3'); // depth-bounded by max
	expect(sql).toContain('walk.depth >= 1'); // WHERE depth >= min
	expect(sql).toContain('NOT LIKE'); // cycle-safe path guard
	expect(sql).toContain('ev.rel = ?'); // rel filter in adjacency
	expect(placeholderCount(sql)).toBe(args.length);
	expect(args).toEqual(['knows', 'person', 'person']);
});

test('P5: only one variable-length segment is allowed (§17)', () => {
	expect(() =>
		match(SCHEMA)
			.node('a', 'person')
			.rel('knows', { min: 1, max: 2 })
			.node('b', 'person')
			.rel('knows', { min: 1, max: 2 })
			.node('c', 'person')
			.toSQL(),
	).toThrow(/ONE variable-length/);
});

test('P5: variable-length with asOf threads temporal params in order', () => {
	const T = 777;
	const { sql, args } = match(SCHEMA)
		.node('a', 'person')
		.where('a', 'name', 'root')
		.rel('knows', { min: 1, max: 2 })
		.node('b', 'person')
		.asOf(T)
		.toSQL();

	expect(sql).toContain('WITH RECURSIVE');
	expect(sql).toContain('node_versions');
	expect(sql).toContain('edge_versions');
	// adjacency rel + temporal first, then anchor temporal + anchor where, then target temporal.
	expect(args).toEqual(['knows', T, T, T, T, 'person', 'root', T, T, 'person']);
	expect(placeholderCount(sql)).toBe(args.length);
});

test('P5: a single-node pattern returns only nodes of the declared type', async () => {
	const { client, g } = await freshGraph();
	await g.addNode({ type: 'person', data: { name: 'ada' } });
	await g.addNode({ type: 'device', data: { type: 'router' } });
	const rows = await (await match(SCHEMA, client).node('d', 'device').select('d')).run();
	expect(rows.map((r) => r.d.type)).toEqual(['device']);
	client.close();
});

test('P5: .run() returns rows typed/shaped per alias against a real graph', async () => {
	const { client, g } = await freshGraph();
	const ada = await g.addNode({ type: 'person', data: { name: 'ada' } });
	const router = await g.addNode({ type: 'device', data: { type: 'router' } });
	const cam = await g.addNode({ type: 'device', data: { type: 'cam' } });
	await g.addEdge({ rel: 'owns', src: ada.id, dst: router.id });
	await g.addEdge({ rel: 'owns', src: ada.id, dst: cam.id });

	const q = await match(SCHEMA, client)
		.node('a', 'person')
		.out('owns')
		.node('b', 'device')
		.select('a', 'b');
	const rows = await q.run();

	expect(rows.length).toBe(2);
	for (const row of rows) {
		expect(row.a.id).toBe(ada.id);
		expect(row.a.type).toBe('person');
		expect(row.a.data).toEqual({ name: 'ada' });
		expect(row.b.type).toBe('device');
		expect(typeof row.b.id).toBe('string');
		expect(row.b.data).toHaveProperty('type');
	}
	const devices = new Set(rows.map((r) => r.b.id));
	expect(devices).toEqual(new Set([router.id, cam.id]));
	client.close();
});

test('P5: .run() applies a .where prop filter', async () => {
	const { client, g } = await freshGraph();
	const ada = await g.addNode({ type: 'person', data: { name: 'ada' } });
	const router = await g.addNode({ type: 'device', data: { type: 'router' } });
	const cam = await g.addNode({ type: 'device', data: { type: 'cam' } });
	await g.addEdge({ rel: 'owns', src: ada.id, dst: router.id });
	await g.addEdge({ rel: 'owns', src: ada.id, dst: cam.id });

	const q = await match(SCHEMA, client)
		.node('a', 'person')
		.out('owns')
		.node('b', 'device')
		.where('b', 'type', 'router')
		.select('a', 'b');
	const rows = await q.run();

	expect(rows.length).toBe(1);
	expect(rows[0]!.b.id).toBe(router.id);
	expect(rows[0]!.b.data).toEqual({ type: 'router' });
	client.close();
});

test('P5: .run() variable-length walk returns reachable nodes (cycle-safe)', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({ type: 'person', data: { name: 'a' } });
	const b = await g.addNode({ type: 'person', data: { name: 'b' } });
	const c = await g.addNode({ type: 'person', data: { name: 'c' } });
	// a -> b -> c -> a (a cycle); a 1..2 hop walk should still terminate.
	await g.addEdge({ rel: 'knows', src: a.id, dst: b.id });
	await g.addEdge({ rel: 'knows', src: b.id, dst: c.id });
	await g.addEdge({ rel: 'knows', src: c.id, dst: a.id });

	const q = await match(SCHEMA, client)
		.node('a', 'person')
		.where('a', 'name', 'a')
		.rel('knows', { min: 1, max: 2 })
		.node('b', 'person')
		.select('b');
	const rows = await q.run();

	// from a: depth1 = b, depth2 = c. (a is excluded by the cycle path guard.)
	const reached = new Set(rows.map((r) => r.b.id));
	expect(reached).toEqual(new Set([b.id, c.id]));
	client.close();
});

test('P5: .run() with asOf + where executes correctly (param order proof, §16)', async () => {
	const { client, g } = await freshGraph();
	const ada = await g.addNode({ type: 'person', data: { name: 'ada' } });
	const bob = await g.addNode({ type: 'person', data: { name: 'bob' } });
	const router = await g.addNode({ type: 'device', data: { type: 'router' } });
	const cam = await g.addNode({ type: 'device', data: { type: 'cam' } });
	await g.addEdge({ rel: 'owns', src: ada.id, dst: router.id });
	await g.addEdge({ rel: 'owns', src: ada.id, dst: cam.id });
	await g.addEdge({ rel: 'owns', src: bob.id, dst: router.id });

	const now = Date.now() + 1_000_000;
	// person named 'ada' --owns--> device of type 'router'. If params were misaligned
	// the temporal/rel/prop bindings would land on the wrong predicate and return [].
	const q = await match(SCHEMA, client)
		.node('a', 'person')
		.where('a', 'name', 'ada')
		.out('owns')
		.node('b', 'device')
		.where('b', 'type', 'router')
		.asOf(now)
		.select('a', 'b');
	const rows = await q.run();

	expect(rows.length).toBe(1);
	expect(rows[0]!.a.data).toEqual({ name: 'ada' });
	expect(rows[0]!.b.data).toEqual({ type: 'router' });
	client.close();
});

test('P5: .run() asOf reads past shape (live row when t in its interval)', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({ type: 'person', data: { name: 'a' } });
	const b = await g.addNode({ type: 'person', data: { name: 'b' } });
	await g.addEdge({ rel: 'knows', src: a.id, dst: b.id });

	// All rows are live (valid_from <= now < FOREVER). asOf=now reads them via *_versions.
	// Pad past the monotonic write clock's high-water mark, still well below FOREVER.
	const now = Date.now() + 1_000_000;
	const q = await match(SCHEMA, client)
		.node('a', 'person')
		.out('knows')
		.node('b', 'person')
		.asOf(now)
		.select('a', 'b');
	const rows = await q.run();
	expect(rows.length).toBe(1);
	expect(rows[0]!.a.id).toBe(a.id);
	expect(rows[0]!.b.id).toBe(b.id);
	client.close();
});
