import { expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Graph, init } from '../../src/core/index.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { makeTestDb } from '../core/harness.ts';
import { Auth } from '../../src/auth/auth.ts';
import { defineAuthModel, rel } from '../../src/auth/model.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

const MODEL = defineAuthModel({
	user: {},
	group: { member: rel() },
	doc: { editor: rel(), viewer: rel() },
});

async function freshAuth(): Promise<{ db: DbClient; auth: Auth }> {
	const db = makeTestDb().client;
	await init(db, hashEmbed(4));
	return { db, auth: new Auth(new Graph(db, MODEL.schema), MODEL) };
}

test('P1: check is true after write, false otherwise', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:bob')).toBe(false);
	expect(await auth.check('doc:42', 'editor', 'user:alice')).toBe(false);
	db.close();
});

test('P1: check is false after delete', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);
	await auth.delete([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false);
	db.close();
});

test('P1: write/check reject an unknown relation', async () => {
	const { db, auth } = await freshAuth();
	await expect(
		auth.write([{ object: 'doc:42', relation: 'owner', subject: 'user:alice' }]),
	).rejects.toThrow();
	await expect(auth.check('doc:42', 'owner', 'user:alice')).rejects.toThrow();
	db.close();
});

test('P1→P2: userset subjects with a valid subjectRelation are accepted', async () => {
	const { db, auth } = await freshAuth();
	// group:eng#member is a valid userset subject; group.member is declared in the model
	await expect(
		auth.write([
			{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' },
		]),
	).resolves.toBeUndefined();
	db.close();
});

test('P1: check asOf sees the grant in the past, not before it or after revoke', async () => {
	const { db, auth } = await freshAuth();
	const tBefore = Date.now();
	await sleep(20);
	await auth.write([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);
	await sleep(20);
	const t1 = Date.now(); // grant is live here
	await sleep(20);
	await auth.delete([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);

	expect(await auth.check('doc:42', 'viewer', 'user:alice', { asOf: tBefore })).toBe(false); // before write
	expect(await auth.check('doc:42', 'viewer', 'user:alice', { asOf: t1 })).toBe(true); // during grant
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false); // live = now (revoked)
	db.close();
});

test('D6: a correction to a past grant changes past checks, never the current one', async () => {
	// file-backed: retractEdge runs a transaction, which detaches a :memory: client
	const { client: db, teardown } = makeTestDb({ file: true });
	await init(db, hashEmbed(4));
	const g = new Graph(db, MODEL.schema);
	const auth = new Auth(g, MODEL);
	await auth.write([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);
	const edge = (await g.listEdges({ rel: 'viewer', dst: 'doc:42' })).edges[0]!;
	await sleep(5);
	const during = Date.now();
	await sleep(5);
	const end = Date.now();
	expect(await auth.check('doc:42', 'viewer', 'user:alice', { asOf: during })).toBe(true);

	// we learn alice's access was suspended for a while: authz reads the current belief
	const start = during - 1;
	await g.retractEdge(edge.id, { validFrom: start, validTo: end });
	expect(await auth.check('doc:42', 'viewer', 'user:alice', { asOf: during })).toBe(false);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	await teardown();
});
