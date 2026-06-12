import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { FOREVER } from '../src/db.ts';
import { journey } from '../src/journey.ts';
import { init } from '../src/schema.ts';

// P7 — journey() (§10, B2). Earliest-arrival time-respecting cascade. Fixtures are
// built with RAW SQL inserts so each test controls edge valid_from/valid_to (and
// node version windows) directly — independent of P6. dim 4 keeps the schema small.

/** Insert a node identity + one version live for [validFrom, validTo). Returns the ULID id. */
async function node(
	client: Client,
	name: string,
	opts: { kind?: string; validFrom?: number; validTo?: number } = {},
): Promise<string> {
	const id = ulid();
	const kind = opts.kind ?? 'thing';
	const validFrom = opts.validFrom ?? 0;
	const validTo = opts.validTo ?? FOREVER;
	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	await client.execute({
		sql: `INSERT INTO node_versions (id, kind, props, valid_from, valid_to)
			VALUES (?, ?, ?, ?, ?)`,
		args: [id, kind, JSON.stringify({ name }), validFrom, validTo],
	});
	return id;
}

/** Insert an edge identity + one version live for [validFrom, validTo). */
async function edge(
	client: Client,
	src: string,
	dst: string,
	opts: { rel?: string; validFrom?: number; validTo?: number } = {},
): Promise<string> {
	const id = ulid();
	const rel = opts.rel ?? 'link';
	const validFrom = opts.validFrom ?? 0;
	const validTo = opts.validTo ?? FOREVER;
	await client.execute({ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: [id] });
	await client.execute({
		sql: `INSERT INTO edge_versions (id, src, dst, rel, valid_from, valid_to)
			VALUES (?, ?, ?, ?, ?, ?)`,
		args: [id, src, dst, rel, validFrom, validTo],
	});
	return id;
}

async function fresh(): Promise<Client> {
	const client = createClient({ url: ':memory:' });
	await init(client, 4);
	return client;
}

test('P7: forward cascade — arrival times propagate, non-decreasing', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const c = await node(client, 'C');
	await edge(client, a, b, { validFrom: 100 });
	await edge(client, b, c, { validFrom: 200 });

	const rows = await journey(client, { start: a, from: 0 });
	const byId = new Map(rows.map((r) => [r.id, r]));
	expect(byId.get(b)!.arrival_t).toBe(100);
	expect(byId.get(c)!.arrival_t).toBe(200);
	// non-decreasing arrival across the ordered result
	const arrivals = rows.map((r) => r.arrival_t);
	for (let i = 1; i < arrivals.length; i++)
		expect(arrivals[i]!).toBeGreaterThanOrEqual(arrivals[i - 1]!);
	// start node is excluded from results
	expect(byId.has(a)).toBe(false);
	client.close();
});

test('P7: severed edge skipped — expired edge is not traversable', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	// edge A->B expired at t=50, but the walker arrives at A at from=100 -> valid_to(50) > 100 is false
	await edge(client, a, b, { validFrom: 0, validTo: 50 });

	const rows = await journey(client, { start: a, from: 100 });
	expect(rows.map((r) => r.id)).not.toContain(b);
	expect(rows.length).toBe(0);
	client.close();
});

test('P7: arrival = max(t_arrive, valid_from) — future edge delays arrival', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	// edge opens at 500 in the "future" relative to from=0 -> arrival delayed to 500
	await edge(client, a, b, { validFrom: 500 });

	const rows = await journey(client, { start: a, from: 0 });
	const b_row = rows.find((r) => r.id === b)!;
	expect(b_row.arrival_t).toBe(500);
	client.close();
});

test('P7: reverse over depends_on chain returns dependents, non-decreasing arrival', async () => {
	const client = await fresh();
	// app depends_on lib depends_on core. Reverse from core walks to dependents.
	const core = await node(client, 'core');
	const lib = await node(client, 'lib');
	const app = await node(client, 'app');
	await edge(client, lib, core, { rel: 'depends_on', validFrom: 100 });
	await edge(client, app, lib, { rel: 'depends_on', validFrom: 200 });

	const rows = await journey(client, {
		start: core,
		from: 0,
		direction: 'reverse',
		rels: ['depends_on'],
	});
	const ids = rows.map((r) => r.id);
	expect(ids).toContain(lib);
	expect(ids).toContain(app);
	const byId = new Map(rows.map((r) => [r.id, r]));
	expect(byId.get(lib)!.arrival_t).toBe(100);
	expect(byId.get(app)!.arrival_t).toBe(200);
	const arrivals = rows.map((r) => r.arrival_t);
	for (let i = 1; i < arrivals.length; i++)
		expect(arrivals[i]!).toBeGreaterThanOrEqual(arrivals[i - 1]!);
	client.close();
});

test('P7: cycle safety — A->B->A terminates', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	await edge(client, a, b, { validFrom: 10 });
	await edge(client, b, a, { validFrom: 20 });

	const rows = await journey(client, { start: a, from: 0 });
	// terminates and returns B (A is the start, excluded)
	expect(rows.map((r) => r.id)).toEqual([b]);
	client.close();
});

test('P7: rels filter restricts traversable edges', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const c = await node(client, 'C');
	await edge(client, a, b, { rel: 'red', validFrom: 100 });
	await edge(client, a, c, { rel: 'blue', validFrom: 100 });

	const redOnly = await journey(client, { start: a, from: 0, rels: ['red'] });
	expect(redOnly.map((r) => r.id)).toEqual([b]);

	const blueOnly = await journey(client, { start: a, from: 0, rels: ['blue'] });
	expect(blueOnly.map((r) => r.id)).toEqual([c]);
	client.close();
});

test('P7: start id is a ULID string and returns rows (proves B2 — no CAST-to-INTEGER)', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	await edge(client, a, b, { validFrom: 100 });

	// start is a 26-char ULID; if it were CAST to INTEGER it would coerce to 0 and match nothing.
	expect(a.length).toBe(26);
	const rows = await journey(client, { start: a, from: 0 });
	expect(rows.length).toBe(1);
	expect(rows[0]!.id).toBe(b);
	expect(rows[0]!.name).toBe('B');
	expect(rows[0]!.kind).toBe('thing');
	expect(rows[0]!.hops).toBe(1);
	client.close();
});

test('P7: maxDepth bounds the cascade', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const c = await node(client, 'C');
	await edge(client, a, b, { validFrom: 100 });
	await edge(client, b, c, { validFrom: 200 });

	const depth1 = await journey(client, { start: a, from: 0, maxDepth: 1 });
	expect(depth1.map((r) => r.id)).toEqual([b]); // C is at hop 2, excluded
	client.close();
});
