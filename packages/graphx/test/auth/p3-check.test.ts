import { expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeTestDb } from '../core/harness.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { Graph, init } from '../../src/core/index.ts';
import { Auth } from '../../src/auth/auth.ts';
import { defineAuthModel, rel, tupleToUserset } from '../../src/auth/model.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

const MODEL = defineAuthModel({
	user: {},
	folder: {
		parent: rel(),
		editor: rel(),
		viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')),
	},
	doc: {
		parent: rel(),
		editor: rel(),
		banned: rel(),
		reviewer: rel(),
		viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')).minus('banned'),
		gated: rel().and('reviewer'), // self ∩ reviewer
	},
});

async function freshAuth(): Promise<{ db: DbClient; auth: Auth }> {
	const db = makeTestDb().client;
	await init(db, hashEmbed(4));
	return { db, auth: new Auth(new Graph(db, MODEL.schema), MODEL) };
}

test('P3: ttu — doc inherits viewer from its parent folder', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'parent', subject: 'folder:1' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:bob')).toBe(false);
	db.close();
});

test('P3: ttu — inheritance climbs the parent chain recursively', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:root', relation: 'viewer', subject: 'user:alice' },
		{ object: 'folder:1', relation: 'parent', subject: 'folder:root' },
		{ object: 'doc:42', relation: 'parent', subject: 'folder:1' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true); // doc → folder:1 → folder:root
	db.close();
});

test('P3: exclusion — banned overrides an otherwise-granted viewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }, // editor ⇒ viewer
		{ object: 'doc:42', relation: 'banned', subject: 'user:alice' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false); // − banned
	db.close();
});

test('P3: exclusion does not over-deny — editor, not banned, is a viewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	db.close();
});

test('P3: intersection — gated requires self AND reviewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'gated', subject: 'user:alice' }, // direct (self side)
		{ object: 'doc:42', relation: 'reviewer', subject: 'user:alice' },
	]);
	expect(await auth.check('doc:42', 'gated', 'user:alice')).toBe(true);

	await auth.write([{ object: 'doc:42', relation: 'gated', subject: 'user:bob' }]); // missing reviewer
	expect(await auth.check('doc:42', 'gated', 'user:bob')).toBe(false);
	db.close();
});

test('P3: ttu + asOf — inheritance visible before the parent link is revoked', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'parent', subject: 'folder:1' },
	]);
	await sleep(20);
	const t1 = Date.now();
	await sleep(20);
	await auth.delete([{ object: 'doc:42', relation: 'parent', subject: 'folder:1' }]); // unlink parent
	expect(await auth.check('doc:42', 'viewer', 'user:alice', { asOf: t1 })).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false); // live: no parent link
	db.close();
});

test('P3: ttu parent cycle terminates and denies; a parallel inherited grant still resolves', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'parent', subject: 'folder:2' },
		{ object: 'folder:2', relation: 'parent', subject: 'folder:1' }, // parent cycle
	]);
	expect(await auth.check('folder:1', 'viewer', 'user:alice')).toBe(false); // must not hang

	// same cyclic graph, but folder:1 also has a parent (folder:3) that grants viewer
	await auth.write([
		{ object: 'folder:3', relation: 'viewer', subject: 'user:alice' },
		{ object: 'folder:1', relation: 'parent', subject: 'folder:3' },
	]);
	expect(await auth.check('folder:1', 'viewer', 'user:alice')).toBe(true);
	db.close();
});

test('P3: exclusion overrides ttu-inherited access (inherited viewer but banned)', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'parent', subject: 'folder:1' }, // alice inherits viewer
		{ object: 'doc:42', relation: 'banned', subject: 'user:alice' }, // but is banned
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false);
	db.close();
});
