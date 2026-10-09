import { expect, test } from 'bun:test';
import { makeTestDb } from '../core/harness.ts';
import { FOREVER, Graph, init } from '../../src/core/index.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { defineAuthModel, rel } from '../../src/auth/model.ts';
import { deleteTuple, ensureObject, liveTupleExists, writeTuple } from '../../src/auth/store.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

async function freshDb(): Promise<DbClient> {
	const client = makeTestDb().client;
	await init(client, hashEmbed(4));
	return client;
}

test('P1: ensureObject creates one live node with id=ref, type=type', async () => {
	const db = await freshDb();
	await ensureObject(db, 'doc:42');
	const r = await db.execute({
		sql: 'SELECT type FROM nodes WHERE id = ?',
		args: ['doc:42'],
	});
	expect(r.rows.length).toBe(1);
	expect(String(r.rows[0]!.type)).toBe('doc');
	db.close();
});

test('P1: ensureObject is idempotent — second call adds no row', async () => {
	const db = await freshDb();
	await ensureObject(db, 'doc:42');
	await ensureObject(db, 'doc:42');
	const r = await db.execute({
		sql: 'SELECT COUNT(*) AS n FROM node_versions WHERE id = ? AND valid_to = ?',
		args: ['doc:42', FOREVER],
	});
	expect(Number(r.rows[0]!.n)).toBe(1);
	db.close();
});

const STORE_MODEL = defineAuthModel({ user: {}, doc: { viewer: rel() } });

test('P1: writeTuple creates a live edge subject→object; check via liveTupleExists', async () => {
	const db = await freshDb();
	const g = new Graph(db, STORE_MODEL.schema);
	await writeTuple(g, { object: 'doc:42', relation: 'viewer', subject: 'user:alice' });
	expect(await liveTupleExists(db, 'user:alice', 'viewer', 'doc:42')).toBe(true);
	expect(await liveTupleExists(db, 'user:bob', 'viewer', 'doc:42')).toBe(false);
	db.close();
});

test('P1: writeTuple is idempotent — duplicate writes leave one live edge', async () => {
	const db = await freshDb();
	const g = new Graph(db, STORE_MODEL.schema);
	const t = { object: 'doc:42', relation: 'viewer', subject: 'user:alice' };
	await writeTuple(g, t);
	await writeTuple(g, t);
	const r = await db.execute({
		sql: 'SELECT COUNT(*) AS n FROM edges WHERE src = ? AND rel = ? AND dst = ?',
		args: ['user:alice', 'viewer', 'doc:42'],
	});
	expect(Number(r.rows[0]!.n)).toBe(1);
	db.close();
});

test('P1: deleteTuple closes the live edge — no live tuple, history retained', async () => {
	const db = await freshDb();
	const g = new Graph(db, STORE_MODEL.schema);
	await writeTuple(g, { object: 'doc:42', relation: 'viewer', subject: 'user:alice' });
	await deleteTuple(db, 'user:alice', 'viewer', 'doc:42');

	expect(await liveTupleExists(db, 'user:alice', 'viewer', 'doc:42')).toBe(false);
	// the closed version still exists with a finite valid_to
	const r = await db.execute({
		sql: 'SELECT valid_to FROM edge_versions WHERE src = ? AND rel = ? AND dst = ? AND recorded_to = 8640000000000000',
		args: ['user:alice', 'viewer', 'doc:42'],
	});
	expect(r.rows.length).toBe(1);
	expect(Number(r.rows[0]!.valid_to)).toBeLessThan(8640000000000000);
	db.close();
});

test('P1: deleteTuple on a missing tuple is a no-op', async () => {
	const db = await freshDb();
	await deleteTuple(db, 'user:ghost', 'viewer', 'doc:42'); // must not throw
	db.close();
});
