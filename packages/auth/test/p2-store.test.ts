import { expect, test } from 'bun:test';
import { makeTestDb } from '../../core/test/harness.ts';
import { Graph, init } from '../../core/src/index.ts';
import type { DbClient } from '../../core/src/dialect.ts';
import { defineAuthModel, rel } from '../src/model.ts';
import { deleteTuple, writeTuple } from '../src/store.ts';

const MODEL = defineAuthModel({ user: {}, group: { member: rel() }, doc: { viewer: rel() } });

async function fresh(): Promise<{ db: DbClient; g: Graph<typeof MODEL.schema> }> {
	const db = makeTestDb().client;
	await init(db, 4);
	return { db, g: new Graph(db, MODEL.schema) };
}

function liveCount(db: DbClient, src: string, rel: string, dst: string): Promise<number> {
	return db
		.execute({
			sql: 'SELECT COUNT(*) AS n FROM edges WHERE src = ? AND rel = ? AND dst = ?',
			args: [src, rel, dst],
		})
		.then((r) => Number(r.rows[0]!.n));
}

test('P2: direct and userset tuples on the same (subject,rel,object) are distinct rows', async () => {
	const { db, g } = await fresh();
	await writeTuple(g, { object: 'doc:42', relation: 'viewer', subject: 'group:eng' }); // direct
	await writeTuple(g, {
		object: 'doc:42',
		relation: 'viewer',
		subject: 'group:eng',
		subjectRelation: 'member',
	}); // userset
	expect(await liveCount(db, 'group:eng', 'viewer', 'doc:42')).toBe(2);
	db.close();
});

test('P2: userset writes are idempotent', async () => {
	const { db, g } = await fresh();
	const t = {
		object: 'doc:42',
		relation: 'viewer',
		subject: 'group:eng',
		subjectRelation: 'member',
	};
	await writeTuple(g, t);
	await writeTuple(g, t);
	expect(await liveCount(db, 'group:eng', 'viewer', 'doc:42')).toBe(1);
	db.close();
});

test('P2: deleteTuple revokes only the matching subjectRelation', async () => {
	const { db, g } = await fresh();
	await writeTuple(g, { object: 'doc:42', relation: 'viewer', subject: 'group:eng' });
	await writeTuple(g, {
		object: 'doc:42',
		relation: 'viewer',
		subject: 'group:eng',
		subjectRelation: 'member',
	});
	await deleteTuple(db, 'group:eng', 'viewer', 'doc:42', 'member'); // revoke only the userset tuple
	expect(await liveCount(db, 'group:eng', 'viewer', 'doc:42')).toBe(1); // the direct one remains
	db.close();
});
