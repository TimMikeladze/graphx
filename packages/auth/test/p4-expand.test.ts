import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Graph, init } from '../../core/src/index.ts';
import { Auth } from '../src/auth.ts';
import type { UsersetTree } from '../src/expand.ts';
import { defineAuthModel, rel, tupleToUserset } from '../src/model.ts';

function collectSubjects(t: UsersetTree): string[] {
	if (t.type === 'leaf') return t.subjects;
	if (t.type === 'exclusion') return [...collectSubjects(t.base), ...collectSubjects(t.subtract)];
	return t.children.flatMap(collectSubjects);
}

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

async function freshAuth(): Promise<{ db: Client; auth: Auth }> {
	const db = createClient({ url: ':memory:' });
	await init(db, 4);
	return { db, auth: new Auth(new Graph(db, MODEL.schema), MODEL) };
}

test('P4: expand self → leaf of sorted direct subjects', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'editor', subject: 'user:bob' },
		{ object: 'doc:42', relation: 'editor', subject: 'user:alice' },
	]);
	expect(await auth.expand('doc:42', 'editor')).toEqual({
		type: 'leaf',
		subjects: ['user:alice', 'user:bob'],
		usersets: [],
	});
	db.close();
});

test('P4: expand self → userset subjects are leaf references (not resolved)', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'editor', subject: 'group:eng', subjectRelation: 'member' },
	]);
	expect(await auth.expand('doc:42', 'editor')).toEqual({
		type: 'leaf',
		subjects: [],
		usersets: [{ object: 'group:eng', relation: 'member' }],
	});
	db.close();
});

test('P4: expand a union(self, computed, ttu) relation — folder.viewer with no parent', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'viewer', subject: 'user:carol' }, // self
		{ object: 'folder:1', relation: 'editor', subject: 'user:dan' }, // computed(editor)
	]);
	// folder.viewer = union(self, computed(editor), ttu(parent, viewer)); folder:1 has no parent
	expect(await auth.expand('folder:1', 'viewer')).toEqual({
		type: 'union',
		children: [
			{ type: 'leaf', subjects: ['user:carol'], usersets: [] }, // self
			{ type: 'leaf', subjects: ['user:dan'], usersets: [] }, // computed(editor)
			{ type: 'union', children: [] }, // ttu — no parents
		],
	});
	db.close();
});

test('P4: expand doc.viewer — exclusion over union, ttu pulls in the parent subtree', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'viewer', subject: 'user:bob' }, // self
		{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }, // computed(editor)
		{ object: 'doc:42', relation: 'parent', subject: 'folder:1' }, // ttu(parent, viewer)
		{ object: 'folder:1', relation: 'viewer', subject: 'user:carol' },
		{ object: 'doc:42', relation: 'banned', subject: 'user:eve' }, // subtract
	]);
	const tree = await auth.expand('doc:42', 'viewer');
	// top = exclusion(base=union[self, editor, ttu], subtract=banned-leaf)
	expect(tree.type).toBe('exclusion');
	if (tree.type !== 'exclusion') throw new Error('unreachable');
	expect(tree.subtract).toEqual({ type: 'leaf', subjects: ['user:eve'], usersets: [] });
	expect(tree.base.type).toBe('union');
	if (tree.base.type !== 'union') throw new Error('unreachable');
	expect(tree.base.children[0]).toEqual({ type: 'leaf', subjects: ['user:bob'], usersets: [] }); // self
	expect(tree.base.children[1]).toEqual({ type: 'leaf', subjects: ['user:alice'], usersets: [] }); // editor
	// ttu child: union of parent expansions → folder:1's viewer subtree
	expect(tree.base.children[2]).toEqual({
		type: 'union',
		children: [
			{
				type: 'union', // folder:1 viewer = union(self, computed editor, ttu)
				children: [
					{ type: 'leaf', subjects: ['user:carol'], usersets: [] },
					{ type: 'leaf', subjects: [], usersets: [] }, // folder:1 editor (none)
					{ type: 'union', children: [] }, // folder:1 has no parent
				],
			},
		],
	});
	db.close();
});

test('P4: expand terminates on a ttu parent cycle (empty leaf at the break)', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'parent', subject: 'folder:2' },
		{ object: 'folder:2', relation: 'parent', subject: 'folder:1' }, // cycle
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
	]);
	// must not hang
	expect(await auth.expand('folder:1', 'viewer')).toEqual({
		type: 'union',
		children: [
			{ type: 'leaf', subjects: ['user:alice'], usersets: [] }, // folder:1 self
			{ type: 'leaf', subjects: [], usersets: [] }, // folder:1 editor
			{
				type: 'union', // ttu(parent,viewer) of folder:1 → [expand(folder:2,viewer)]
				children: [
					{
						type: 'union', // folder:2 viewer
						children: [
							{ type: 'leaf', subjects: [], usersets: [] }, // folder:2 self
							{ type: 'leaf', subjects: [], usersets: [] }, // folder:2 editor
							{
								type: 'union', // ttu of folder:2 → [expand(folder:1,viewer)] hits cycle
								children: [{ type: 'leaf', subjects: [], usersets: [] }], // cycle break = empty leaf
							},
						],
					},
				],
			},
		],
	});
	db.close();
});

test('P4: expand respects asOf', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }]);
	await sleep(20);
	const t1 = Date.now();
	await sleep(20);
	await auth.delete([{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }]);
	expect(await auth.expand('doc:42', 'editor', { asOf: t1 })).toEqual({
		type: 'leaf',
		subjects: ['user:alice'],
		usersets: [],
	});
	expect(await auth.expand('doc:42', 'editor')).toEqual({ type: 'leaf', subjects: [], usersets: [] });
	db.close();
});

test('P4: diamond — a shared ancestor expands fully on both ttu arms', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:root', relation: 'viewer', subject: 'user:alice' },
		{ object: 'folder:a', relation: 'parent', subject: 'folder:root' },
		{ object: 'folder:b', relation: 'parent', subject: 'folder:root' },
		{ object: 'doc:1', relation: 'parent', subject: 'folder:a' },
		{ object: 'doc:1', relation: 'parent', subject: 'folder:b' },
	]);
	const tree = await auth.expand('doc:1', 'viewer');
	expect(tree.type).toBe('exclusion');
	if (tree.type !== 'exclusion') throw new Error('unreachable');
	expect(tree.base.type).toBe('union');
	if (tree.base.type !== 'union') throw new Error('unreachable');
	const ttu = tree.base.children[2]; // [self, computed(editor), ttu]
	expect(ttu?.type).toBe('union');
	if (!ttu || ttu.type !== 'union') throw new Error('unreachable');
	expect(ttu.children.length).toBe(2); // folder:a and folder:b arms
	for (const arm of ttu.children) {
		expect(collectSubjects(arm)).toContain('user:alice'); // folder:root fully expanded on each arm
	}
	db.close();
});
