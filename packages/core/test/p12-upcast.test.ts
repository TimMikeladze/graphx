import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { afterAll, expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { FOREVER } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { Graph } from '../src/graph.ts';
import { match } from '../src/pattern.ts';
import { init } from '../src/schema.ts';
import { defineUpcasters, Upcaster } from '../src/upcast.ts';

// P12 — schema evolution / read-time upcasting (§15). JSON props make add/remove
// free; history is immutable. Writes stamp the kind's current `_v`; OLD-version
// props are upcast to the latest shape AT READ TIME via a per-kind upcaster chain
// (vN→vN+1), then the latest Zod schema `.parse()`s the result.
//
// asOf DECISION (the §15 prose-vs-acceptance fork, resolved): upcast EVERYWHERE
// INCLUDING asOf — there is exactly ONE (latest) Zod parser per kind, so every read
// surface that returns a typed `NodeOf<S,K>` (getNode/neighbors/PatternBuilder, incl.
// `.asOf`) must yield the latest shape or the runtime value diverges from its static
// type. "asOf returns v1 shape" is honored as STORAGE immutability: the stored
// node_versions bytes stay byte-for-byte v1 (asserted directly), while in-memory is
// always the upcast latest shape.

// device v2: crit -> criticality (rename), + status (added with a default).
const deviceV2 = z.object({
	name: z.string(),
	criticality: z.number(),
	status: z.string().default('online'),
});
// device v3: + tier (added with a default); criticality/name/status carried.
const deviceV3 = z.object({
	name: z.string(),
	criticality: z.number(),
	status: z.string().default('online'),
	tier: z.string().default('standard'),
});

const SCHEMA_V2 = defineGraphSchema({
	nodes: {
		device: deviceV2,
		person: z.object({ name: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device' },
	},
});

const SCHEMA_V3 = defineGraphSchema({
	nodes: {
		device: deviceV3,
		person: z.object({ name: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device' },
	},
});

// v1 -> v2: rename crit -> criticality, default status.
const UPCAST_V2 = defineUpcasters({
	device: {
		current: 2,
		steps: [(p) => ({ name: p.name, criticality: p.crit, status: 'online' })],
	},
});

// v1 -> v2 -> v3: the second step adds tier.
const UPCAST_V3 = defineUpcasters({
	device: {
		current: 3,
		steps: [
			(p) => ({ name: p.name, criticality: p.crit, status: 'online' }),
			(p) => ({ ...p, tier: 'standard' }),
		],
	},
});

// ---------- pure-unit: the Upcaster chain (no DB) ----------

test('P12 (unit): v1 props upcast to the v2 shape; _v stripped, defaults applied', () => {
	const u = new Upcaster(SCHEMA_V2, UPCAST_V2);
	const out = u.apply('device', { name: 'r1', crit: 5, _v: 1 });
	expect(out).toEqual({ name: 'r1', criticality: 5, status: 'online' });
	expect('_v' in out).toBe(false);
	expect('crit' in out).toBe(false);
});

test('P12 (unit): missing `_v` is treated as v1 and upcasts (back-compat)', () => {
	const u = new Upcaster(SCHEMA_V2, UPCAST_V2);
	const out = u.apply('device', { name: 'r1', crit: 7 });
	expect(out).toEqual({ name: 'r1', criticality: 7, status: 'online' });
});

test('P12 (unit): multi-step v1 -> v2 -> v3 upcasts straight to v3', () => {
	const u = new Upcaster(SCHEMA_V3, UPCAST_V3);
	const out = u.apply('device', { name: 'r1', crit: 9, _v: 1 });
	expect(out).toEqual({ name: 'r1', criticality: 9, status: 'online', tier: 'standard' });
});

test('P12 (unit): a v2 row read under v3 runs ONLY the v2->v3 step', () => {
	const u = new Upcaster(SCHEMA_V3, UPCAST_V3);
	// already-v2-shaped bytes, tagged _v=2: only step[1] (v2->v3) runs.
	const out = u.apply('device', { name: 'r1', criticality: 4, status: 'offline', _v: 2 });
	expect(out).toEqual({ name: 'r1', criticality: 4, status: 'offline', tier: 'standard' });
});

test('P12 (unit): an already-current (v3) row is a no-op chain (then parsed)', () => {
	const u = new Upcaster(SCHEMA_V3, UPCAST_V3);
	const out = u.apply('device', {
		name: 'r1',
		criticality: 1,
		status: 'online',
		tier: 'gold',
		_v: 3,
	});
	expect(out).toEqual({ name: 'r1', criticality: 1, status: 'online', tier: 'gold' });
});

test('P12 (unit): unregistered kind returns props unchanged (additive)', () => {
	const u = new Upcaster(SCHEMA_V2, UPCAST_V2);
	const raw = { name: 'ada' };
	const out = u.apply('person', raw);
	expect(out).toEqual({ name: 'ada' });
});

test('P12 (unit): empty registry is identity for every kind', () => {
	const u = new Upcaster(SCHEMA_V2, {});
	const raw = { name: 'r1', crit: 5, _v: 1 };
	expect(u.apply('device', raw)).toBe(raw); // same ref — fully untouched
});

test('P12 (unit): stampVersion returns current for registered kinds, undefined otherwise', () => {
	const u = new Upcaster(SCHEMA_V2, UPCAST_V2);
	expect(u.stampVersion('device')).toBe(2);
	expect(u.stampVersion('person')).toBeUndefined();
});

// ---- construction-time registry validation (fail fast on misconfiguration) ----

test('P12 (unit): a too-short steps array throws at construction (steps.length != current-1)', () => {
	expect(
		() => new Upcaster(SCHEMA_V3, { device: { current: 3, steps: [(p) => ({ ...p })] } }), // 1, needs 2
	).toThrow(/step/);
});

test('P12 (unit): a too-LONG steps array also throws at construction', () => {
	expect(
		() =>
			new Upcaster(SCHEMA_V2, {
				device: { current: 2, steps: [(p) => ({ ...p }), (p) => ({ ...p })] }, // 2, needs 1
			}),
	).toThrow(/step/);
});

test('P12 (unit): current < 1 (or non-integer) throws at construction', () => {
	expect(() => new Upcaster(SCHEMA_V2, { device: { current: 0, steps: [] } })).toThrow(/current/);
	expect(() => new Upcaster(SCHEMA_V2, { device: { current: 1.5, steps: [] } })).toThrow(/current/);
});

test('P12 (unit): a registered kind with no schema.nodes entry throws at construction', () => {
	expect(
		() => new Upcaster(SCHEMA_V2, { ghost: { current: 2, steps: [(p) => ({ ...p })] } }),
	).toThrow(/schema|matching/);
});

// ---- downgrade: stored _v > current must throw, never silently drop newer data ----

test('P12 (unit): a downgrade (stored _v > current) throws instead of silently dropping fields', () => {
	const u = new Upcaster(SCHEMA_V2, UPCAST_V2); // current = 2
	expect(() =>
		u.apply('device', { name: 'r1', criticality: 7, status: 'offline', tier: 'gold', _v: 3 }),
	).toThrow(/downgrade|newer/);
});

// ---- reserved key: a registered kind may not declare `_v` ----

test('P12 (unit): stamp throws when a registered kind declares the reserved `_v` prop', () => {
	const u = new Upcaster(SCHEMA_V2, UPCAST_V2);
	expect(() => u.stamp('device', { name: 'r1', criticality: 5, _v: 9 })).toThrow(/reserved|_v/);
});

test('P12 (unit): stamp on an unregistered kind is a no-op passthrough (no `_v` added)', () => {
	const u = new Upcaster(SCHEMA_V2, UPCAST_V2);
	const raw = { name: 'ada' };
	expect(u.stamp('person', raw)).toBe(raw);
});

// ---------- shared DB fixtures for the integration tests below ----------

const DIM = 4;
const tmpFiles: string[] = [];

async function freshClient(): Promise<Client> {
	const file = join(tmpdir(), `graphx-p12-${ulid()}.db`);
	tmpFiles.push(file);
	const client = createClient({ url: `file:${file}` });
	await init(client, DIM);
	return client;
}

afterAll(() => {
	for (const f of tmpFiles) {
		for (const suffix of ['', '-wal', '-shm']) {
			try {
				rmSync(f + suffix);
			} catch {
				// best-effort cleanup
			}
		}
	}
});

/** Insert a raw node version directly (controls props bytes + valid window). */
async function rawNode(
	client: Client,
	props: Record<string, unknown>,
	opts: { kind?: string; validFrom?: number; validTo?: number } = {},
): Promise<string> {
	const id = ulid();
	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	await client.execute({
		sql: 'INSERT INTO node_versions (id, kind, props, valid_from, valid_to) VALUES (?,?,?,?,?)',
		args: [id, opts.kind ?? 'device', JSON.stringify(props), opts.validFrom ?? 0, opts.validTo ?? FOREVER],
	});
	return id;
}

/** Read the raw stored props text for a node's live version (bypasses upcast). */
async function rawProps(client: Client, id: string): Promise<string> {
	const r = await client.execute({
		sql: 'SELECT props FROM node_versions WHERE id = ? AND valid_to = ?',
		args: [id, FOREVER],
	});
	return String(r.rows[0]!.props);
}

// ---------- getNode / neighbors: read-time upcast ----------

test('P12: a v1 raw row reads back as the v2 shape via getNode (upcaster ran)', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_V2, UPCAST_V2);
	const id = await rawNode(client, { name: 'r1', crit: 5, _v: 1 });

	const node = await g.getNode(id);
	expect(node!.props).toEqual({ name: 'r1', criticality: 5, status: 'online' });
	client.close();
});

test('P12: the stored v1 bytes are UNCHANGED after a read (history immutable)', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_V2, UPCAST_V2);
	const id = await rawNode(client, { name: 'r1', crit: 5, _v: 1 });
	const before = await rawProps(client, id);

	await g.getNode(id); // read upcasts in memory only

	const after = await rawProps(client, id);
	expect(after).toBe(before);
	expect(JSON.parse(after)).toEqual({ name: 'r1', crit: 5, _v: 1 }); // still v1 on disk
	client.close();
});

test('P12: a no-`_v` raw row reads back upcast (pre-P12 row back-compat)', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_V2, UPCAST_V2);
	const id = await rawNode(client, { name: 'old', crit: 3 }); // NO _v
	const node = await g.getNode(id);
	expect(node!.props).toEqual({ name: 'old', criticality: 3, status: 'online' });
	client.close();
});

test('P12: a v1 raw row upcasts through neighbors() too', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_V2, UPCAST_V2);
	const person = await rawNode(client, { name: 'owner' }, { kind: 'person' });
	const dev = await rawNode(client, { name: 'r1', crit: 5, _v: 1 });
	await g.addEdge({ rel: 'owns', src: person, dst: dev });

	const nb = await g.neighbors(person, { direction: 'forward' });
	const got = nb.find((n) => n.id === dev)!;
	expect(got.props).toEqual({ name: 'r1', criticality: 5, status: 'online' });
	client.close();
});

// ---------- addNode / updateNode: write-time `_v` stamp ----------

test('P12: addNode stamps the kind current `_v` into stored bytes; getNode returns clean shape', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_V2, UPCAST_V2);
	const node = await g.addNode({ kind: 'device', props: { name: 'fresh', criticality: 2 } });

	// in-memory: clean v2 shape, no `_v`
	expect(node.props).toEqual({ name: 'fresh', criticality: 2, status: 'online' });
	expect('_v' in (node.props as object)).toBe(false);

	// on disk: `_v=2` stamped alongside the parsed props
	const stored = JSON.parse(await rawProps(client, node.id));
	expect(stored._v).toBe(2);
	expect(stored.criticality).toBe(2);

	// read back is the clean v2 shape
	const read = await g.getNode(node.id);
	expect(read!.props).toEqual({ name: 'fresh', criticality: 2, status: 'online' });
	client.close();
});

test('P12: addNode on an UNREGISTERED kind stamps no `_v` (byte-identical to pre-P12)', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_V2, UPCAST_V2);
	const node = await g.addNode({ kind: 'person', props: { name: 'ada' } });
	const stored = JSON.parse(await rawProps(client, node.id));
	expect(stored).toEqual({ name: 'ada' }); // no `_v`
	client.close();
});

test('P12: updateNode upcasts a v1 row forward — successor is current-shaped and `_v`-stamped', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_V2, UPCAST_V2);
	const id = await rawNode(client, { name: 'r1', crit: 5, _v: 1 });

	// patch only status; the v1 row must first migrate to v2 (crit -> criticality) then merge.
	await g.updateNode(id, { props: { status: 'offline' } });

	const stored = JSON.parse(await rawProps(client, id));
	expect(stored._v).toBe(2);
	expect(stored.criticality).toBe(5); // carried via the v1->v2 upcaster
	expect(stored.status).toBe('offline'); // patched
	expect('crit' in stored).toBe(false); // old field gone on the successor

	const read = await g.getNode(id);
	expect(read!.props).toEqual({ name: 'r1', criticality: 5, status: 'offline' });
	client.close();
});

test('P12: updateNode leaves the OLD (closed) v1 version bytes immutable', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_V2, UPCAST_V2);
	const id = await rawNode(client, { name: 'r1', crit: 5, _v: 1 });

	await g.updateNode(id, { props: { status: 'offline' } });

	// the closed version still carries the original v1 bytes
	const rows = await client.execute({
		sql: 'SELECT props, valid_to FROM node_versions WHERE id = ? ORDER BY valid_from',
		args: [id],
	});
	expect(rows.rows.length).toBe(2);
	const closed = rows.rows.find((r) => Number(r.valid_to) !== FOREVER)!;
	expect(JSON.parse(String(closed.props))).toEqual({ name: 'r1', crit: 5, _v: 1 });
	client.close();
});

// ---------- PatternBuilder.asOf: upcast EVERYWHERE (the decision) ----------

test('P12 (asOf DECISION): a v1-era row read via .asOf() also upcasts to the v2 shape', async () => {
	const client = await freshClient();
	// a historical v1 device, live across [10, FOREVER) so an asOf(50) lands in its era.
	const id = await rawNode(client, { name: 'r1', crit: 5, _v: 1 }, { validFrom: 10 });

	const q = await match(SCHEMA_V2, client, UPCAST_V2).node('d', 'device').asOf(50).select('d');
	const rows = await q.run();
	const row = rows.find((r) => r.d.id === id)!;
	// decision (a): in-memory is the upcast latest shape even for a past asOf read
	expect(row.d.props).toEqual({ name: 'r1', criticality: 5, status: 'online' });

	// but the underlying stored bytes are STILL v1 (storage immutability = "v1 shape")
	const stored = await client.execute({
		sql: 'SELECT props FROM node_versions WHERE id = ?',
		args: [id],
	});
	expect(JSON.parse(String(stored.rows[0]!.props))).toEqual({ name: 'r1', crit: 5, _v: 1 });
	client.close();
});

test('P12: PatternBuilder with an empty registry is byte-identical (no upcast)', async () => {
	const client = await freshClient();
	const id = await rawNode(client, { name: 'r1', crit: 5, _v: 1 });
	const q = await match(SCHEMA_V2, client).node('d', 'device').select('d');
	const rows = await q.run();
	const row = rows.find((r) => r.d.id === id)!;
	// no registry -> raw bytes pass through untouched (incl. crit + _v)
	expect(row.d.props).toEqual({ name: 'r1', crit: 5, _v: 1 });
	client.close();
});

// ---------- journey: opt-in name projection upcast ----------

test('P12: journey upcasts the name projection when an upcaster is supplied', async () => {
	const client = await freshClient();
	// v1 schema stored `fullName`; v2 renames it to `name`. journey projects `name`.
	const schemaV2 = defineGraphSchema({
		nodes: { user: z.object({ name: z.string() }) },
		edges: { link: {} },
	});
	const upcast = defineUpcasters({
		user: { current: 2, steps: [(p) => ({ name: p.fullName })] },
	});
	const { journey } = await import('../src/journey.ts');

	const a = await rawNode(client, { fullName: 'Ada', _v: 1 }, { kind: 'user' });
	const b = await rawNode(client, { fullName: 'Bob', _v: 1 }, { kind: 'user' });
	await client.execute({ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: ['e_p12j'] });
	await client.execute({
		sql: 'INSERT INTO edge_versions (id, src, dst, rel, valid_from) VALUES (?,?,?,?,?)',
		args: ['e_p12j', a, b, 'link', 100],
	});

	const upc = new Upcaster(schemaV2, upcast);
	const rows = await journey(client, { start: a, from: 0, upcaster: upc });
	expect(rows.find((r) => r.id === b)!.name).toBe('Bob'); // renamed field projected
	client.close();
});

// ---------- updateNode kind-change into a registered kind (honest stamp) ----------

const gadgetV2 = z.object({ label: z.string(), watts: z.number().default(0) });
const SCHEMA_DG = defineGraphSchema({
	nodes: { device: deviceV2, gadget: gadgetV2 },
	edges: {},
});
const UPCAST_DG = defineUpcasters({
	device: { current: 2, steps: [(p) => ({ name: p.name, criticality: p.crit, status: 'online' })] },
	gadget: { current: 2, steps: [(p) => ({ ...p, watts: 0 })] },
});

test('P12: updateNode kind-change into a registered kind reshapes under the SUCCESSOR schema (no foreign fields, honest `_v`)', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_DG, UPCAST_DG);
	const id = await rawNode(client, { name: 'r1', crit: 5, _v: 1 }); // a v1 device

	// retarget to gadget, supplying the gadget field
	await g.updateNode(id, { kind: 'gadget', props: { label: 'g1' } });

	const stored = JSON.parse(await rawProps(client, id));
	// stored bytes are genuinely gadget-v2 shaped + honestly stamped — NOT device-shaped
	expect(stored._v).toBe(2);
	expect(stored.label).toBe('g1');
	expect(stored.watts).toBe(0);
	expect('name' in stored).toBe(false); // device fields did NOT leak in
	expect('criticality' in stored).toBe(false);

	const read = await g.getNode(id);
	expect(read!.kind).toBe('gadget');
	expect(read!.props).toEqual({ label: 'g1', watts: 0 });
	client.close();
});

// ---------- reserved `_v` key guard ----------

const recV2 = z.object({ name: z.string(), _v: z.number().default(7) }); // illegally declares `_v`
const SCHEMA_REC = defineGraphSchema({ nodes: { rec: recV2 }, edges: {} });
const UPCAST_REC = defineUpcasters({ rec: { current: 2, steps: [(p) => ({ ...p })] } });

test('P12: addNode on a registered kind that declares the reserved `_v` throws (no silent clobber)', async () => {
	const client = await freshClient();
	const g = new Graph(client, SCHEMA_REC, UPCAST_REC);
	await expect(g.addNode({ kind: 'rec', props: { name: 'x' } })).rejects.toThrow(/reserved|_v/);
	client.close();
});

// ---------- bulkLoad stamps `_v` (else registry reads mis-upcast) ----------

test('P12: bulkLoad stamps the kind `_v`; the row reads back clean under a registry', async () => {
	const { bulkLoad } = await import('../src/bulk.ts');
	const client = await freshClient();

	const res = await bulkLoad(
		client,
		SCHEMA_V2,
		[{ kind: 'device', props: { name: 'b1', criticality: 5 } }],
		{ upcasters: UPCAST_V2 },
	);
	const id = res.ids[0]!;

	// stored bytes carry `_v=2`
	const stored = JSON.parse(await rawProps(client, id));
	expect(stored._v).toBe(2);

	// reading under the registry does NOT re-run the v1->v2 chain over already-v2 data
	const g = new Graph(client, SCHEMA_V2, UPCAST_V2);
	const read = await g.getNode(id);
	expect(read!.props).toEqual({ name: 'b1', criticality: 5, status: 'online' });
	client.close();
});

test('P12: bulkLoad WITHOUT upcasters stamps no `_v` (byte-identical to pre-P12)', async () => {
	const { bulkLoad } = await import('../src/bulk.ts');
	const client = await freshClient();
	const res = await bulkLoad(client, SCHEMA_V2, [
		{ kind: 'device', props: { name: 'b1', criticality: 5 } },
	]);
	const stored = JSON.parse(await rawProps(client, res.ids[0]!));
	expect('_v' in stored).toBe(false);
	client.close();
});

// ---------- asOf over a genuinely SUPERSEDED (closed) v1 version ----------

test('P12 (asOf DECISION): a CLOSED v1 version read via .asOf() upcasts to latest; its bytes stay v1', async () => {
	const client = await freshClient();
	const id = ulid();
	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	// a CLOSED v1 version live across [10, 100) — the now-view will NOT return this row.
	await client.execute({
		sql: 'INSERT INTO node_versions (id, kind, props, valid_from, valid_to) VALUES (?,?,?,?,?)',
		args: [id, 'device', JSON.stringify({ name: 'r1', crit: 5, _v: 1 }), 10, 100],
	});
	// a v2 successor live across [100, FOREVER)
	await client.execute({
		sql: 'INSERT INTO node_versions (id, kind, props, valid_from, valid_to) VALUES (?,?,?,?,?)',
		args: [id, 'device', JSON.stringify({ name: 'r1', criticality: 9, status: 'online', _v: 2 }), 100, FOREVER],
	});

	// asOf(50) lands INSIDE the closed v1 era — the live now-view cannot serve this.
	const q = await match(SCHEMA_V2, client, UPCAST_V2).node('d', 'device').asOf(50).select('d');
	const row = (await q.run()).find((r) => r.d.id === id)!;
	// decision (a): the historical v1 bytes are upcast to the latest shape in memory
	expect(row.d.props).toEqual({ name: 'r1', criticality: 5, status: 'online' });

	// the CLOSED v1 version row bytes are byte-identical v1 (immutable history)
	const closed = await client.execute({
		sql: 'SELECT props FROM node_versions WHERE id = ? AND valid_to = ?',
		args: [id, 100],
	});
	expect(JSON.parse(String(closed.rows[0]!.props))).toEqual({ name: 'r1', crit: 5, _v: 1 });
	client.close();
});
