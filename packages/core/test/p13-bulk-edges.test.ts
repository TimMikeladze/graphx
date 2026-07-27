import { expect, test } from 'bun:test';
import { z } from 'zod';
import { bulkEdges, type BulkEdgeRow, bulkLoad, type BulkRow } from '../src/bulk.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { history } from '../src/temporal.ts';
import { makeTestDb } from './harness.ts';

// P13 — bulk EDGE ingestion + historical (multi-version) bulk rows. dim 4.
//
// `bulkEdges` is the edge sibling of `bulkLoad`: the seed/import path that avoids the two
// endpoint SELECTs + one write batch that `Graph.addEdge` costs per edge. The optional
// `id`/`validFrom`/`validTo` fields on both loaders let one identity carry several version
// rows, so an import can carry real history rather than a flat as-of-now snapshot.

const SCHEMA = defineGraphSchema({
	nodes: {
		person: z.object({ name: z.string() }),
		org: z.object({ name: z.string() }),
	},
	edges: {
		knows: { from: 'person', to: 'person', data: z.object({ since: z.number() }).partial() },
		works_at: { from: 'person', to: 'org' },
		// single-valued: bulkEdges must refuse it (it cannot close a predecessor).
		reports_to: { from: 'person', to: 'person', single: true },
	},
});

async function mem(): Promise<DbClient> {
	const c = makeTestDb().client;
	await init(c, 4);
	return c;
}

/** Load `people` persons + `orgs` orgs, returning ids and the id→type map bulkEdges validates against. */
async function seedNodes(
	client: DbClient,
	people: number,
	orgs = 0,
): Promise<{ persons: string[]; orgs: string[]; types: Map<string, string> }> {
	const rows: BulkRow<typeof SCHEMA>[] = [
		...Array.from({ length: people }, (_, i) => ({
			type: 'person' as const,
			data: { name: `p${i}` },
			body: `person ${i}`,
		})),
		...Array.from({ length: orgs }, (_, i) => ({
			type: 'org' as const,
			data: { name: `o${i}` },
			body: `org ${i}`,
		})),
	];
	const res = await bulkLoad(client, SCHEMA, rows);
	const persons = res.ids.slice(0, people);
	const orgIds = res.ids.slice(people);
	const types = new Map<string, string>([
		...persons.map((id) => [id, 'person'] as const),
		...orgIds.map((id) => [id, 'org'] as const),
	]);
	return { persons, orgs: orgIds, types };
}

test('P13 bulkEdges: inserts N edges, queryable through the live view and neighbors', async () => {
	const client = await mem();
	const { persons } = await seedNodes(client, 20);

	// a path p0 → p1 → ... → p19
	const rows: BulkEdgeRow<typeof SCHEMA>[] = persons.slice(0, -1).map((src, i) => ({
		rel: 'knows' as const,
		src,
		dst: persons[i + 1]!,
	}));
	const res = await bulkEdges(client, SCHEMA, rows);
	expect(res.count).toBe(19);
	expect(res.ids.length).toBe(19);

	const c = await client.execute('SELECT COUNT(*) AS c FROM edges');
	expect(Number(c.rows[0]!.c)).toBe(19);

	// endpoints resolve: p1 sits between p0 and p2
	const g = new Graph(client, SCHEMA);
	const nb = await g.neighbors(persons[1]!, { direction: 'both' });
	expect(nb.map((n) => n.id).sort()).toEqual([persons[0]!, persons[2]!].sort());
	client.close();
});

test('P13 bulkEdges: weight, data and source round-trip', async () => {
	const client = await mem();
	const { persons } = await seedNodes(client, 2);
	await bulkEdges(client, SCHEMA, [
		{
			rel: 'knows',
			src: persons[0]!,
			dst: persons[1]!,
			weight: 0.25,
			data: { since: 1999 },
			source: 'seed',
		},
	]);
	const r = await client.execute('SELECT weight, data, source FROM edges');
	expect(Number(r.rows[0]!.weight)).toBeCloseTo(0.25);
	expect(JSON.parse(String(r.rows[0]!.data))).toEqual({ since: 1999 });
	expect(String(r.rows[0]!.source)).toBe('seed');
	client.close();
});

test('P13 bulkEdges: unknown rel throws', async () => {
	const client = await mem();
	const { persons } = await seedNodes(client, 2);
	const bad = [{ rel: 'ghost', src: persons[0], dst: persons[1] }] as unknown as BulkEdgeRow<
		typeof SCHEMA
	>[];
	await expect(bulkEdges(client, SCHEMA, bad)).rejects.toThrow(/unknown rel/);
	client.close();
});

test('P13 bulkEdges: invalid edge data throws before any write', async () => {
	const client = await mem();
	const { persons } = await seedNodes(client, 2);
	const bad = [
		{ rel: 'knows', src: persons[0]!, dst: persons[1]!, data: { since: 'nineteen' } },
	] as unknown as BulkEdgeRow<typeof SCHEMA>[];
	await expect(bulkEdges(client, SCHEMA, bad)).rejects.toThrow();
	const c = await client.execute('SELECT COUNT(*) AS c FROM edge_versions');
	expect(Number(c.rows[0]!.c)).toBe(0);
	client.close();
});

test('P13 bulkEdges: a single-valued rel is refused', async () => {
	const client = await mem();
	const { persons } = await seedNodes(client, 2);
	await expect(
		bulkEdges(client, SCHEMA, [{ rel: 'reports_to', src: persons[0]!, dst: persons[1]! }]),
	).rejects.toThrow(/single-valued/);
	client.close();
});

test('P13 bulkEdges: endpoint type violation throws when a type map is supplied', async () => {
	const client = await mem();
	const { persons, orgs, types } = await seedNodes(client, 2, 1);
	// `knows` is person→person; an org destination must be rejected.
	await expect(
		bulkEdges(client, SCHEMA, [{ rel: 'knows', src: persons[0]!, dst: orgs[0]! }], { types }),
	).rejects.toThrow(/expected one of/);
	// the same edge under `works_at` (person→org) is fine
	const ok = await bulkEdges(
		client,
		SCHEMA,
		[{ rel: 'works_at', src: persons[0]!, dst: orgs[0]! }],
		{ types },
	);
	expect(ok.count).toBe(1);
	client.close();
});

test('P13 bulkEdges: an unknown endpoint id throws when a type map is supplied', async () => {
	const client = await mem();
	const { persons, types } = await seedNodes(client, 2);
	await expect(
		bulkEdges(client, SCHEMA, [{ rel: 'knows', src: persons[0]!, dst: 'MISSING' }], { types }),
	).rejects.toThrow(/unknown endpoint/);
	client.close();
});

// --- historical rows ---

test('P13 bulk history: one node id carries several versions, readable as-of', async () => {
	const client = await mem();
	const id = 'HIST0000000000000000000001';
	await bulkLoad(client, SCHEMA, [
		{ id, type: 'person', data: { name: 'v1' }, body: 'first', validFrom: 1000, validTo: 2000 },
		{ id, type: 'person', data: { name: 'v2' }, body: 'second', validFrom: 2000, validTo: 3000 },
		{ id, type: 'person', data: { name: 'v3' }, body: 'third', validFrom: 3000 },
	]);

	const versions = await history(client, id);
	expect(versions.length).toBe(3);

	// exactly one identity row, despite three version rows
	const idc = await client.execute({
		sql: 'SELECT COUNT(*) AS c FROM node_identity WHERE id = ?',
		args: [id],
	});
	expect(Number(idc.rows[0]!.c)).toBe(1);

	// the middle interval is what an as-of read at t=2500 sees
	const mid = await client.execute({
		sql: 'SELECT data FROM node_versions WHERE id = ? AND valid_from <= ? AND ? < valid_to',
		args: [id, 2500, 2500],
	});
	expect(mid.rows.length).toBe(1);
	expect(JSON.parse(String(mid.rows[0]!.data)).name).toBe('v2');

	// and the open version is the one the live view returns
	const g = new Graph(client, SCHEMA);
	const live = await g.getNode(id);
	expect((live!.data as { name: string }).name).toBe('v3');
	client.close();
});

test('P13 bulk history: mixed supplied and minted ids in one load', async () => {
	const client = await mem();
	const id = 'HIST0000000000000000000002';
	const res = await bulkLoad(client, SCHEMA, [
		{ id, type: 'person', data: { name: 'a' }, validFrom: 1000, validTo: 2000 },
		{ id, type: 'person', data: { name: 'b' }, validFrom: 2000 },
		{ type: 'person', data: { name: 'fresh' } },
	]);
	// ids come back in input order, the supplied one echoed as given
	expect(res.ids[0]).toBe(id);
	expect(res.ids[1]).toBe(id);
	expect(res.ids[2]).not.toBe(id);
	expect(res.count).toBe(3);

	const idc = await client.execute('SELECT COUNT(*) AS c FROM node_identity');
	expect(Number(idc.rows[0]!.c)).toBe(2); // one supplied + one minted
	client.close();
});

test('P13 bulk history: overlapping intervals for one id throw', async () => {
	const client = await mem();
	const id = 'HIST0000000000000000000003';
	await expect(
		bulkLoad(client, SCHEMA, [
			{ id, type: 'person', data: { name: 'a' }, validFrom: 1000, validTo: 3000 },
			{ id, type: 'person', data: { name: 'b' }, validFrom: 2000 },
		]),
	).rejects.toThrow(/overlap/);
	client.close();
});

test('P13 bulk history: two open versions for one id throw', async () => {
	const client = await mem();
	const id = 'HIST0000000000000000000004';
	await expect(
		bulkLoad(client, SCHEMA, [
			{ id, type: 'person', data: { name: 'a' }, validFrom: 1000 },
			{ id, type: 'person', data: { name: 'b' }, validFrom: 2000 },
		]),
	).rejects.toThrow(/at most one open/);
	client.close();
});

test('P13 bulk history: an id with no open version loads as a tombstoned identity', async () => {
	const client = await mem();
	const id = 'HIST0000000000000000000005';
	// At most one open version — a fully closed timeline is legal and means the entity
	// existed and ended. It has history but no live row.
	await bulkLoad(client, SCHEMA, [
		{ id, type: 'person', data: { name: 'a' }, validFrom: 1000, validTo: 2000 },
	]);
	expect((await history(client, id)).length).toBe(1);
	const g = new Graph(client, SCHEMA);
	expect(await g.getNode(id)).toBeNull();
	client.close();
});

test('P13 bulk history: an inverted interval throws', async () => {
	const client = await mem();
	await expect(
		bulkLoad(client, SCHEMA, [
			{ type: 'person', data: { name: 'a' }, validFrom: 5000, validTo: 4000 },
		]),
	).rejects.toThrow(/validFrom/);
	client.close();
});

test('P13 bulk history: a closed edge leaves the live view but is visible as-of', async () => {
	const client = await mem();
	const { persons } = await seedNodes(client, 2);
	await bulkEdges(client, SCHEMA, [
		{ rel: 'knows', src: persons[0]!, dst: persons[1]!, validFrom: 1000, validTo: 2000 },
	]);

	const live = await client.execute('SELECT COUNT(*) AS c FROM edges');
	expect(Number(live.rows[0]!.c)).toBe(0);

	const asOf = await client.execute({
		sql: 'SELECT COUNT(*) AS c FROM edge_versions WHERE valid_from <= ? AND ? < valid_to',
		args: [1500, 1500],
	});
	expect(Number(asOf.rows[0]!.c)).toBe(1);
	client.close();
});

test('P13 bulk history: one edge id carries several versions', async () => {
	const client = await mem();
	const { persons } = await seedNodes(client, 2);
	const id = 'EHIST000000000000000000001';
	await bulkEdges(client, SCHEMA, [
		{
			id,
			rel: 'knows',
			src: persons[0]!,
			dst: persons[1]!,
			weight: 0.1,
			validFrom: 1000,
			validTo: 2000,
		},
		{ id, rel: 'knows', src: persons[0]!, dst: persons[1]!, weight: 0.9, validFrom: 2000 },
	]);
	const idc = await client.execute('SELECT COUNT(*) AS c FROM edge_identity');
	expect(Number(idc.rows[0]!.c)).toBe(1);
	const live = await client.execute('SELECT weight FROM edges');
	expect(live.rows.length).toBe(1);
	expect(Number(live.rows[0]!.weight)).toBeCloseTo(0.9);
	client.close();
});
