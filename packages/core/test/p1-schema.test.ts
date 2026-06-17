import { expect, test } from 'bun:test';
import { FOREVER } from '../src/db.ts';
import type { DbClient } from '../src/dialect.ts';
import { ensureColumn, init, schema } from '../src/schema.ts';
import { makeTestDb, TEST_DRIVER } from './harness.ts';

// libSQL schema-MECHANICS probes (PRAGMA, sqlite_master, EXPLAIN QUERY PLAN, vector_top_k,
// table_xinfo). The cross-backend schema contract is exercised by every other suite.
const libsqlOnly = TEST_DRIVER === 'postgres' ? test.skip : test;

// P1 schema init (§4 + §4.1, D1/D5/B9). Proves the temporal schema, adjacency &
// temporal indexes, the live-only views, the weight CHECK, and the vector index
// are all created by init() on the pinned @libsql/client, and that re-running is
// a no-op.

function mem(): DbClient {
	return makeTestDb().client;
}

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const ULID_B = '01ARZ3NDEKTSV4RRFFQ69G5FBB';
const ULID_E = '01ARZ3NDEKTSV4RRFFQ69G5FEE';

test('P1: schema(dim) substitutes the embedding dimension', () => {
	expect(schema(4)).toContain('F32_BLOB(4)');
	expect(schema()).toContain('F32_BLOB(768)'); // default dim
	// every CREATE is guarded with IF NOT EXISTS
	const creates = schema().match(/CREATE\s+(TABLE|INDEX|VIEW)/gi) ?? [];
	const guarded = schema().match(/CREATE\s+(TABLE|INDEX|VIEW)\s+IF NOT EXISTS/gi) ?? [];
	expect(guarded.length).toBe(creates.length);
});

libsqlOnly('P1: init() twice is a no-op (no throw)', async () => {
	const c = mem();
	await init(c);
	await init(c); // re-run, idempotent via IF NOT EXISTS
	const fk = await c.execute('PRAGMA foreign_keys');
	expect(Number(fk.rows[0]!.foreign_keys)).toBe(1); // applyConnPragmas ran
	c.close();
});

libsqlOnly('P1: all tables and views exist after init()', async () => {
	const c = mem();
	await init(c);
	const r = await c.execute(
		"SELECT name, type FROM sqlite_master WHERE name IN ('node_identity','edge_identity','node_versions','edge_versions','nodes','edges','archival_state')",
	);
	const byName = new Map(r.rows.map((x) => [String(x.name), String(x.type)]));
	expect(byName.get('node_identity')).toBe('table');
	expect(byName.get('edge_identity')).toBe('table');
	expect(byName.get('node_versions')).toBe('table');
	expect(byName.get('edge_versions')).toBe('table');
	expect(byName.get('nodes')).toBe('view');
	expect(byName.get('edges')).toBe('view');
	expect(byName.get('archival_state')).toBe('table');
	c.close();
});

libsqlOnly('P1: edge adjacency indexes used — src => ev_src_asof, dst => ev_dst_asof', async () => {
	const c = mem();
	await init(c);
	// Insert a handful of rows + ANALYZE so the planner prefers the index over a
	// scan of a tiny table (identity rows first to satisfy the FKs).
	for (let i = 0; i < 20; i++) {
		const id = String(i).padStart(26, '0');
		await c.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	}
	for (let i = 0; i < 19; i++) {
		const eid = `E${String(i).padStart(25, '0')}`;
		await c.execute({ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: [eid] });
		await c.execute({
			sql: 'INSERT INTO edge_versions (id, src, dst, rel, valid_from) VALUES (?,?,?,?,?)',
			args: [eid, String(i).padStart(26, '0'), String(i + 1).padStart(26, '0'), 'rel', 1],
		});
	}
	await c.execute('ANALYZE');

	const fwd = await c.execute({
		sql: 'EXPLAIN QUERY PLAN SELECT * FROM edge_versions WHERE src = ?',
		args: [ULID_A],
	});
	const fwdPlan = fwd.rows
		.map((x) => String(x.detail))
		.join(' ')
		.toLowerCase();
	expect(fwdPlan).toContain('ev_src_asof');

	const rev = await c.execute({
		sql: 'EXPLAIN QUERY PLAN SELECT * FROM edge_versions WHERE dst = ?',
		args: [ULID_B],
	});
	const revPlan = rev.rows
		.map((x) => String(x.detail))
		.join(' ')
		.toLowerCase();
	expect(revPlan).toContain('ev_dst_asof');
	c.close();
});

test('P1: weight CHECK(weight >= 0) rejects a negative-weight edge_version', async () => {
	const c = mem();
	await init(c);
	await c.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [ULID_A] });
	await c.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [ULID_B] });
	await c.execute({ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: [ULID_E] });
	await expect(
		c.execute({
			sql: 'INSERT INTO edge_versions (id, src, dst, rel, weight, valid_from) VALUES (?,?,?,?,?,?)',
			args: [ULID_E, ULID_A, ULID_B, 'rel', -1, 1],
		}),
	).rejects.toThrow();
	c.close();
});

test('P1: nodes view returns only live rows (valid_to = FOREVER)', async () => {
	const c = mem();
	await init(c, 4);
	await c.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [ULID_A] });
	// one closed (historical) version + one live version for the same id
	await c.execute({
		sql: 'INSERT INTO node_versions (ver, id, kind, valid_from, valid_to) VALUES (?,?,?,?,?)',
		args: [1, ULID_A, 'old', 1, 100],
	});
	await c.execute({
		sql: 'INSERT INTO node_versions (ver, id, kind, valid_from, valid_to) VALUES (?,?,?,?,?)',
		args: [2, ULID_A, 'new', 100, FOREVER],
	});
	// view filters out the closed row; only the live one shows
	const r = await c.execute({ sql: 'SELECT kind FROM nodes WHERE id = ?', args: [ULID_A] });
	expect(r.rows.length).toBe(1);
	expect(String(r.rows[0]!.kind)).toBe('new');
	c.close();
});

libsqlOnly('P1 EMPIRICAL: vector index nv_emb_idx is usable via vector_top_k', async () => {
	const c = mem();
	await init(c, 4); // dim 4 for the test
	await c.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [ULID_A] });
	await c.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [ULID_B] });
	// two LIVE node versions with embeddings
	await c.execute({
		sql: 'INSERT INTO node_versions (ver, id, kind, emb, valid_from) VALUES (?,?,?,vector(?),?)',
		args: [1, ULID_A, 'k', '[1,0,0,0]', 1],
	});
	await c.execute({
		sql: 'INSERT INTO node_versions (ver, id, kind, emb, valid_from) VALUES (?,?,?,vector(?),?)',
		args: [2, ULID_B, 'k', '[0,1,0,0]', 1],
	});
	// query nearest to [1,0,0,0] — must come back via the nv_emb_idx index
	const r = await c.execute({
		sql: "SELECT n.id FROM vector_top_k('nv_emb_idx', vector(?), 1) v JOIN node_versions n ON n.rowid = v.id",
		args: ['[1,0,0,0]'],
	});
	expect(r.rows.length).toBe(1);
	expect(String(r.rows[0]!.id)).toBe(ULID_A);
	c.close();
});

libsqlOnly('P1: ensureColumn adds a generated column once, idempotently', async () => {
	const c = mem();
	await init(c, 4);
	await ensureColumn(
		c,
		'node_versions',
		'entity_type',
		"ALTER TABLE node_versions ADD COLUMN entity_type TEXT GENERATED ALWAYS AS (props ->> 'entity_type')",
	);
	// second call is a no-op (column already present)
	await ensureColumn(
		c,
		'node_versions',
		'entity_type',
		"ALTER TABLE node_versions ADD COLUMN entity_type TEXT GENERATED ALWAYS AS (props ->> 'entity_type')",
	);
	await c.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [ULID_A] });
	await c.execute({
		sql: 'INSERT INTO node_versions (ver, id, kind, props, valid_from) VALUES (?,?,?,?,?)',
		args: [1, ULID_A, 'k', JSON.stringify({ entity_type: 'device' }), 1],
	});
	const r = await c.execute({ sql: 'SELECT entity_type FROM node_versions WHERE ver = 1' });
	expect(String(r.rows[0]!.entity_type)).toBe('device');
	c.close();
});
