import { describe, expect, test } from 'bun:test';
import { createDuckClient } from '../../src/core/duck.ts';
import { embParam } from '../../src/core/duck-value.ts';
import {
	annSeeds,
	jsonArrayRows,
	jsonEqArg,
	jsonEqExpr,
	jsonField,
	scalarMax,
} from '../../src/core/dialect-sql.ts';
import { init } from '../../src/core/schema.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

const FOREVER = 8640000000000000;

describe('duckdb fragments, executed', () => {
	test('jsonField extracts an unquoted scalar', async () => {
		const c = createDuckClient();
		const sql = `SELECT ${jsonField('duckdb', 'data', 'k')} AS v FROM (SELECT '{"k":"foo"}' AS data)`;
		expect((await c.execute(sql)).rows[0]?.v).toBe('foo');
		await c.end();
	});

	test('jsonEqExpr matches a string value — the silent-false trap', async () => {
		// json_extract returns JSON, so `= 'foo'` compares '"foo"' to 'foo' and is FALSE
		// with no error. The duckdb arm must use json_extract_string.
		const c = createDuckClient();
		const sql = `SELECT count(*) AS n FROM (SELECT '{"k":"foo"}' AS data) WHERE ${jsonEqExpr('duckdb', 'data', 'k')}`;
		const r = await c.execute({ sql, args: [jsonEqArg('duckdb', 'foo')] });
		expect(r.rows[0]?.n).toBe(1);
		await c.end();
	});

	test('jsonEqExpr matches a numeric value coerced to text', async () => {
		const c = createDuckClient();
		const sql = `SELECT count(*) AS n FROM (SELECT '{"k":7}' AS data) WHERE ${jsonEqExpr('duckdb', 'data', 'k')}`;
		const r = await c.execute({ sql, args: [jsonEqArg('duckdb', 7)] });
		expect(r.rows[0]?.n).toBe(1);
		await c.end();
	});

	test('jsonArrayRows expands to UNQUOTED ids', async () => {
		// A naive unnest(json_extract(...)) yields '"a"' with the quotes, which joins to
		// zero rows against a TEXT id column — silently, and only under real data.
		const c = createDuckClient();
		const r = await c.execute({
			sql: jsonArrayRows('duckdb'),
			args: [JSON.stringify(['a', 'b'])],
		});
		expect(r.rows.map((x) => x.id)).toEqual(['a', 'b']);
		await c.end();
	});

	test('scalarMax is the two-argument scalar form', async () => {
		const c = createDuckClient();
		const r = await c.execute(`SELECT ${scalarMax('duckdb', '3', '7')} AS m`);
		expect(r.rows[0]?.m).toBe(7);
		await c.end();
	});

	test('annSeeds returns vector rows ordered by true cosine distance with the distance', async () => {
		const c = createDuckClient();
		await init(c, hashEmbed(3));
		for (const [id, vec] of [
			['near', [1, 0, 0]],
			['far', [0, 0, 1]],
			['mid', [1, 1, 0]],
		] as const) {
			await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: [id] });
			await c.execute({
				sql: `INSERT INTO node_versions (ver, id, type, valid_from, valid_to)
				      VALUES (nextval('seq_ver'), ?, 'Doc', 1, ${FOREVER})`,
				args: [id],
			});
			await c.execute({
				sql: `INSERT INTO node_embeddings (id, chunk, emb, embed_hash)
				      VALUES (?, 0, from_json(?, '["FLOAT"]'), 'h')`,
				args: [id, embParam([...vec])],
			});
		}
		const { sql, bind } = annSeeds('duckdb');
		const r = await c.execute({ sql, args: bind(embParam([1, 0, 0]), 3) });
		expect(r.rows.map((x) => x.id)).toEqual(['near', 'mid', 'far']);
		expect(Number(r.rows[0]?.dist)).toBeCloseTo(0, 5);
		expect(Number(r.rows[2]?.dist)).toBeCloseTo(1, 5);
		await c.end();
	});
});
