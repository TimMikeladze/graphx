import { expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeTestDb } from '../core/harness.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { Graph, init } from '../../src/core/index.ts';
import { Auth } from '../../src/auth/auth.ts';
import { defineAuthModel, rel, tupleToUserset } from '../../src/auth/model.ts';

const MODEL = defineAuthModel({
	user: {},
	group: { member: rel() },
	folder: {
		parent: rel(),
		editor: rel(),
		viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')),
	},
	doc: {
		parent: rel(),
		editor: rel(),
		banned: rel(),
		viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')).minus('banned'),
	},
});

async function freshAuth(): Promise<{ db: DbClient; auth: Auth }> {
	const db = makeTestDb().client;
	await init(db, 4);
	return { db, auth: new Auth(new Graph(db, MODEL.schema), MODEL) };
}

test('P5: lists direct + computed + group + ttu grants, sorted; excludes banned & wrong type', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' }, // direct
		{ object: 'doc:2', relation: 'editor', subject: 'user:alice' }, // computed editor⇒viewer
		{ object: 'group:eng', relation: 'member', subject: 'user:alice' },
		{ object: 'doc:3', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' }, // group
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:4', relation: 'parent', subject: 'folder:1' }, // ttu inheritance
		{ object: 'doc:5', relation: 'editor', subject: 'user:alice' }, // editor ⇒ viewer ...
		{ object: 'doc:5', relation: 'banned', subject: 'user:alice' }, // ... but banned
	]);
	const page = await auth.listObjects('user:alice', 'viewer', 'doc');
	expect(page.objects).toEqual(['doc:1', 'doc:2', 'doc:3', 'doc:4']); // sorted; doc:5 excluded (banned)
	expect(page.nextCursor).toBeNull();
	db.close();
});

test('P5: type filter — listing folders returns only folders', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
	]);
	expect((await auth.listObjects('user:alice', 'viewer', 'folder')).objects).toEqual(['folder:1']);
	db.close();
});

test('P5: empty when the subject has no grants of that relation', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:1', relation: 'editor', subject: 'user:bob' }]);
	expect((await auth.listObjects('user:alice', 'viewer', 'doc')).objects).toEqual([]);
	db.close();
});

test('P5: respects asOf — a revoked grant is gone live but present in the past', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' }]);
	await sleep(20);
	const t1 = Date.now();
	await sleep(20);
	await auth.delete([{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' }]);
	expect((await auth.listObjects('user:alice', 'viewer', 'doc', { asOf: t1 })).objects).toEqual([
		'doc:1',
	]);
	expect((await auth.listObjects('user:alice', 'viewer', 'doc')).objects).toEqual([]);
	db.close();
});

test('P5: paginates by object id — limit then cursor walks the rest', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:2', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:3', relation: 'viewer', subject: 'user:alice' },
	]);
	const p1 = await auth.listObjects('user:alice', 'viewer', 'doc', { limit: 2 });
	expect(p1.objects).toEqual(['doc:1', 'doc:2']);
	expect(p1.nextCursor).toBe('doc:2');

	const p2 = await auth.listObjects('user:alice', 'viewer', 'doc', {
		limit: 2,
		cursor: p1.nextCursor!,
	});
	expect(p2.objects).toEqual(['doc:3']);
	expect(p2.nextCursor).toBeNull();
	db.close();
});

test('P5: limit ≥ result count returns everything with a null cursor', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:2', relation: 'viewer', subject: 'user:alice' },
	]);
	const page = await auth.listObjects('user:alice', 'viewer', 'doc', { limit: 10 });
	expect(page.objects).toEqual(['doc:1', 'doc:2']);
	expect(page.nextCursor).toBeNull();
	db.close();
});

test('P5: a reachable-but-ungranted candidate between grants does not corrupt the page', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:2', relation: 'banned', subject: 'user:alice' }, // reachable via banned edge, NOT a viewer
		{ object: 'doc:3', relation: 'viewer', subject: 'user:alice' },
	]);
	const p1 = await auth.listObjects('user:alice', 'viewer', 'doc', { limit: 2 });
	expect(p1.objects).toEqual(['doc:1', 'doc:3']); // doc:2 is a candidate but check-filtered
	expect(p1.nextCursor).toBe('doc:3');

	const p2 = await auth.listObjects('user:alice', 'viewer', 'doc', { limit: 2, cursor: 'doc:3' });
	expect(p2.objects).toEqual([]);
	expect(p2.nextCursor).toBeNull();
	db.close();
});
