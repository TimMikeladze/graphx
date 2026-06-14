import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Graph, init } from '../../core/src/index.ts';
import { Auth } from '../src/auth.ts';
import { defineAuthModel, rel } from '../src/model.ts';

const MODEL = defineAuthModel({
	user: {},
	group: { member: rel() },
	team: { member: rel() },
	doc: { editor: rel(), viewer: rel().or('editor') },
});

async function freshAuth(): Promise<{ db: Client; auth: Auth }> {
	const db = createClient({ url: ':memory:' });
	await init(db, 4);
	return { db, auth: new Auth(new Graph(db, MODEL.schema), MODEL) };
}

test('P2: computed userset — editor implies viewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true); // via editor⇒viewer
	expect(await auth.check('doc:42', 'viewer', 'user:bob')).toBe(false);
	db.close();
});

test('P2: group userset — member of a group that is viewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'group:eng', relation: 'member', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:carol')).toBe(false);
	db.close();
});

test('P2: nested groups — membership recurses', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'team:core', relation: 'member', subject: 'user:alice' },
		{ object: 'group:eng', relation: 'member', subject: 'team:core', subjectRelation: 'member' },
		{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	db.close();
});

test('P2: membership cycle terminates and denies', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'group:b', relation: 'member', subject: 'group:a', subjectRelation: 'member' },
		{ object: 'group:a', relation: 'member', subject: 'group:b', subjectRelation: 'member' },
	]);
	expect(await auth.check('group:a', 'member', 'user:nobody')).toBe(false); // no hang
	db.close();
});

test('P2: asOf — group membership revoked after t1', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'group:eng', relation: 'member', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' },
	]);
	await sleep(20);
	const t1 = Date.now();
	await sleep(20);
	await auth.delete([{ object: 'group:eng', relation: 'member', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice', { asOf: t1 })).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false); // live: membership gone
	db.close();
});

test('P2: write rejects a userset whose subjectRelation is undeclared on the subject type', async () => {
	const { db, auth } = await freshAuth();
	await expect(
		auth.write([
			{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'admin' },
		]),
	).rejects.toThrow(/unknown relation/);
	db.close();
});

test('P2: diamond — two independent group paths both grant (no false denial)', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'group:a', relation: 'member', subject: 'user:alice' },
		{ object: 'group:b', relation: 'member', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'viewer', subject: 'group:a', subjectRelation: 'member' },
		{ object: 'doc:42', relation: 'viewer', subject: 'group:b', subjectRelation: 'member' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	db.close();
});

test('P2: cycle between groups but subject has direct membership — should grant', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		// mutual member cycle between group:a and group:b
		{ object: 'group:b', relation: 'member', subject: 'group:a', subjectRelation: 'member' },
		{ object: 'group:a', relation: 'member', subject: 'group:b', subjectRelation: 'member' },
		// alice is a DIRECT member of group:b
		{ object: 'group:b', relation: 'member', subject: 'user:alice' },
		// doc viewer = group:a#member
		{ object: 'doc:42', relation: 'viewer', subject: 'group:a', subjectRelation: 'member' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	db.close();
});
