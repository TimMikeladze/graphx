import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { afterAll, expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import {
	declareSingleValuedRel,
	declareUniqueNodeProp,
	materializeConstraints,
} from '../src/constraints.ts';
import { FOREVER } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';

// P14 — constraints (§19.5). Uniqueness is a partial UNIQUE index over LIVE rows only
// (historical versions never collide); edge cardinality marks a rel single-valued so a
// second live (src, rel) closes the first (conditional-close, mirrors updateNode) and a
// partial unique index hard-guarantees it. File DBs: updateNode uses transaction()
// which detaches a :memory: connection.

const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({ serial: z.string(), name: z.string().optional() }),
		gadget: z.object({ serial: z.string() }),
	},
	edges: {
		attached_to: { from: 'gadget', to: 'device', single: true },
		near: { from: 'device', to: 'device' },
	},
});

const tmpFiles: string[] = [];
async function freshGraph(): Promise<{ client: Client; g: Graph<typeof SCHEMA> }> {
	const file = join(tmpdir(), `graphx-p14c-${ulid()}.db`);
	tmpFiles.push(file);
	const client = createClient({ url: `file:${file}` });
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
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

async function liveEdgeCount(client: Client, src: string, rel: string): Promise<number> {
	const r = await client.execute({
		sql: 'SELECT COUNT(*) AS c FROM edge_versions WHERE src = ? AND rel = ? AND valid_to = ?',
		args: [src, rel, FOREVER],
	});
	return Number(r.rows[0]?.c);
}

// --- uniqueness -----------------------------------------------------------------

test('P14 unique: a duplicate LIVE unique prop value is rejected', async () => {
	const { client, g } = await freshGraph();
	await declareUniqueNodeProp(client, { kind: 'device', prop: 'serial' });
	await g.addNode({ kind: 'device', props: { serial: 'SN-1' } });
	await expect(g.addNode({ kind: 'device', props: { serial: 'SN-1' } })).rejects.toThrow();
	// the first one survives (exactly one live device with that serial)
	const r = await client.execute({
		sql: "SELECT COUNT(*) AS c FROM node_versions WHERE kind='device' AND valid_to=? AND json_extract(props,'$.serial')='SN-1'",
		args: [FOREVER],
	});
	expect(Number(r.rows[0]?.c)).toBe(1);
	client.close();
});

test('P14 unique: historical versions with the same value do NOT collide', async () => {
	const { client, g } = await freshGraph();
	await declareUniqueNodeProp(client, { kind: 'device', prop: 'serial' });
	const d = await g.addNode({ kind: 'device', props: { serial: 'SN-2' }, body: 'v1' });
	// update keeps the same serial but is a new live version; the old closes. The
	// partial index is live-only, so the closed v1 (still serial SN-2) does not clash.
	await g.updateNode(d.id, { body: 'v2' });
	const rows = await client.execute({
		sql: 'SELECT valid_to FROM node_versions WHERE id = ? ORDER BY valid_from',
		args: [d.id],
	});
	expect(rows.rows.length).toBe(2);
	expect(rows.rows.filter((x) => Number(x.valid_to) === FOREVER).length).toBe(1);
	client.close();
});

test('P14 unique: the same value on a DIFFERENT kind is allowed (kind-scoped index)', async () => {
	const { client, g } = await freshGraph();
	await declareUniqueNodeProp(client, { kind: 'device', prop: 'serial' });
	await g.addNode({ kind: 'device', props: { serial: 'SHARED' } });
	// gadget also has serial SHARED — different kind, not covered by ux_device_serial
	await expect(g.addNode({ kind: 'gadget', props: { serial: 'SHARED' } })).resolves.toBeTruthy();
	client.close();
});

test('P14 unique: two (kind,prop) pairs that share an underscore-join do NOT collapse to one index', async () => {
	const { client } = await freshGraph();
	// `user_account`+`id` and `user`+`account_id` both naively join to `ux_user_account_id`.
	// If the index name collides, the 2nd CREATE IF NOT EXISTS silently no-ops and its
	// uniqueness is never enforced.
	await declareUniqueNodeProp(client, { kind: 'user_account', prop: 'id' });
	await declareUniqueNodeProp(client, { kind: 'user', prop: 'account_id' });
	// satisfy FK + insert two LIVE `user` rows with the same account_id by raw sql
	for (const id of ['u1', 'u2']) {
		await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	}
	const mkUser = (id: string) => ({
		sql: 'INSERT INTO node_versions (id, kind, props, valid_from) VALUES (?,?,?,?)',
		args: [id, 'user', JSON.stringify({ account_id: 'ACC-1' }), 1],
	});
	await client.execute(mkUser('u1'));
	await expect(client.execute(mkUser('u2'))).rejects.toThrow();
	client.close();
});

// --- edge cardinality -----------------------------------------------------------

test('P14 cardinality: a second single-valued edge closes the first (exactly one live)', async () => {
	const { client, g } = await freshGraph();
	await materializeConstraints(client, SCHEMA);
	const gad = await g.addNode({ kind: 'gadget', props: { serial: 'G1' } });
	const d1 = await g.addNode({ kind: 'device', props: { serial: 'D1' } });
	const d2 = await g.addNode({ kind: 'device', props: { serial: 'D2' } });

	await g.addEdge({ rel: 'attached_to', src: gad.id, dst: d1.id });
	await g.addEdge({ rel: 'attached_to', src: gad.id, dst: d2.id });

	expect(await liveEdgeCount(client, gad.id, 'attached_to')).toBe(1);
	// and the surviving live edge points at d2 (last write wins)
	const live = await client.execute({
		sql: 'SELECT dst FROM edge_versions WHERE src = ? AND rel = ? AND valid_to = ?',
		args: [gad.id, 'attached_to', FOREVER],
	});
	expect(String(live.rows[0]?.dst)).toBe(d2.id);
	client.close();
});

test('P14 cardinality: a multi-valued rel keeps BOTH live edges (no regression)', async () => {
	const { client, g } = await freshGraph();
	await materializeConstraints(client, SCHEMA);
	const d1 = await g.addNode({ kind: 'device', props: { serial: 'A' } });
	const d2 = await g.addNode({ kind: 'device', props: { serial: 'B' } });
	const d3 = await g.addNode({ kind: 'device', props: { serial: 'C' } });
	await g.addEdge({ rel: 'near', src: d1.id, dst: d2.id });
	await g.addEdge({ rel: 'near', src: d1.id, dst: d3.id });
	expect(await liveEdgeCount(client, d1.id, 'near')).toBe(2);
	client.close();
});

test('P14 cardinality: the partial unique index hard-rejects a raw duplicate live edge', async () => {
	const { client } = await freshGraph();
	await declareSingleValuedRel(client, 'attached_to');
	// satisfy the FKs first so the ONLY thing that can fail the 2nd insert is the
	// partial unique index (not a foreign-key violation).
	for (const id of ['srcX', 'dA', 'dB']) {
		await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	}
	await client.execute({ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: ['e1'] });
	await client.execute({ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: ['e2'] });
	const mk = (id: string, dst: string) => ({
		sql: 'INSERT INTO edge_versions (id, src, dst, rel, weight, props, valid_from) VALUES (?,?,?,?,?,?,?)',
		args: [id, 'srcX', dst, 'attached_to', 1.0, '{}', 1],
	});
	// two live attached_to edges from the same src — the second must be rejected.
	await client.execute(mk('e1', 'dA'));
	await expect(client.execute(mk('e2', 'dB'))).rejects.toThrow();
	client.close();
});
