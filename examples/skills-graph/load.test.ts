/**
 * The loader's contract, checked against a hand-built collector database rather than the real
 * one — so this runs anywhere, without the multi-GB corpus.
 *
 * The last test does use the real database when it happens to be there, but only for its node
 * pass and the first edge batch: walking all 2.7M transitions belongs in the build, not the
 * test suite.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { arrivalQuarter, buildNodes, type NodePlan, type PlanEdge, streamEdges } from './load.ts';
import { skillsSchema } from './schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'skills-load-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ONET_AT = '2026-01-01T00:00:00.000Z';
const JOBHOP_AT = '2026-01-02T00:00:00.000Z';

/** A miniature `skills_graph.db`: one O*NET occupation, two skills, three ESCO codes, two moves. */
function fixture(name: string): Database {
	const db = new Database(join(dir, `${name}.db`), { create: true });
	db.run(`
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT, url TEXT, license TEXT,
      access_method TEXT, last_fetched_at TEXT);
    CREATE TABLE occupations (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT,
      preferred_label TEXT, description TEXT, taxonomy_code TEXT);
    CREATE TABLE skills (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT,
      preferred_label TEXT, description TEXT, skill_type TEXT);
    CREATE TABLE occupation_skill_edges (occupation_id INTEGER, skill_id INTEGER,
      relation_type TEXT, source_id INTEGER);
    CREATE TABLE career_transitions (id INTEGER PRIMARY KEY, source_id INTEGER,
      from_occupation_external_id TEXT, to_occupation_external_id TEXT, weight REAL,
      timestamp_info TEXT);
    CREATE TABLE crosswalks (id INTEGER PRIMARY KEY, system_a TEXT, code_a TEXT, system_b TEXT,
      code_b TEXT, source_id INTEGER, match_method TEXT, confidence REAL);
  `);
	db.run(
		`INSERT INTO sources VALUES (1,'O*NET Database','https://onetcenter.org','CC BY 4.0','direct_download',?)`,
		[ONET_AT],
	);
	db.run(`INSERT INTO sources VALUES (2,'Nesta',NULL,'MIT','direct_download',?)`, [ONET_AT]);
	db.run(`INSERT INTO sources VALUES (3,'JobHop',NULL,'CC BY 4.0','direct_download',?)`, [
		JOBHOP_AT,
	]);
	db.run(
		`INSERT INTO occupations VALUES (1,1,'11-1011.00','Chief Executives','runs things','11-1011')`,
	);
	db.run(`INSERT INTO occupations VALUES (2,1,NULL,'Nameless',NULL,NULL)`); // no code ⇒ skipped
	db.run(`INSERT INTO skills VALUES (1,1,'2.A.1.a','Reading Comprehension',NULL,'skill')`);
	db.run(`INSERT INTO skills VALUES (2,2,'6109','reading',NULL,'skill')`);
	db.run(`INSERT INTO occupation_skill_edges VALUES (1,1,'essential',1),(1,2,'related',1)`);
	db.run(`INSERT INTO career_transitions VALUES (1,3,'1212.2','4416.1',1.0,'Q3 2000 -> Q4 2003')`);
	db.run(`INSERT INTO career_transitions VALUES (2,3,'4416.1','1212.2',1.0,'Q1 1990 -> Q1 1993')`);
	db.run(`INSERT INTO career_transitions VALUES (3,3,'4416.1','9999.9',1.0,NULL)`);
	db.run(
		`INSERT INTO crosswalks VALUES (1,'ESCO-Code','1212.2','ESCO-Label','human resources manager',3,'official',1.0)`,
	);
	db.run(
		`INSERT INTO crosswalks VALUES (2,'ESCO-Code','4416.1','ESCO-Label','human resources assistant',3,'official',1.0)`,
	);
	db.run(
		`INSERT INTO crosswalks VALUES (3,'ONET-SOC','11-1011.00','ESCO-Label','human resources manager',1,'fuzzy',0.74)`,
	);
	db.run(
		`INSERT INTO crosswalks VALUES (4,'ONET-Element','2.A.1.a','Nesta-SkillId','6109',2,'fuzzy',0.77)`,
	);
	db.run(`INSERT INTO crosswalks VALUES (5,'ISCO','1212','SOC','11-1011',1,'official',1.0)`);
	return db;
}

async function collect(db: Database, plan: NodePlan, batchSize = 1_000) {
	const batches: PlanEdge[][] = [];
	const result = await streamEdges(db, plan, async (batch) => void batches.push(batch), batchSize);
	return { ...result, batches, all: batches.flat() };
}

const db = fixture('basic');
const plan = buildNodes(db);
const { all, skipped: edgeSkipped } = await collect(db, plan);

function ofType(type: string) {
	return plan.nodes.filter((n) => n.type === type);
}
function ofRel(rel: string) {
	return all.filter((e) => e.rel === rel);
}

test('parses the arrival quarter, and only a well-formed one', () => {
	expect(arrivalQuarter('Q3 2000 -> Q4 2003')).toBe(Date.UTC(2003, 9, 1));
	expect(arrivalQuarter('Q1 1990 -> Q1 1993')).toBe(Date.UTC(1993, 0, 1));
	expect(arrivalQuarter(null)).toBeUndefined();
	expect(arrivalQuarter('2003')).toBeUndefined();
});

test('emits one node per usable row, and skips the ones missing a code or label', () => {
	expect(ofType('source')).toHaveLength(3);
	expect(ofType('occupation')).toHaveLength(1);
	expect(ofType('skill')).toHaveLength(2);
	expect(plan.skipped['occupation without a label or code']).toBe(1);
});

test('turns every referenced ESCO code into a node, named where a crosswalk names it', () => {
	const codes = ofType('occupation_code');
	expect(codes.map((n) => n.data.code).sort()).toEqual(['1212.2', '4416.1', '9999.9']);
	const unnamed = codes.find((n) => n.data.code === '9999.9');
	// Nothing in the corpus names 9999.9, so it keeps its code and says so.
	expect(unnamed?.data.named).toBe(false);
	expect(unnamed?.data.label).toBe('9999.9');
	expect(codes.find((n) => n.data.code === '1212.2')?.data.label).toBe('human resources manager');
});

test('dates a code from its earliest observed move, not from the scrape', () => {
	const codes = new Map(ofType('occupation_code').map((n) => [n.data.code, n.validFrom]));
	// 4416.1 arrives in Q4 2003 and departs in Q1 1990 → its earliest appearance is 1993's arrival.
	expect(codes.get('4416.1')).toBe(Date.UTC(1993, 0, 1));
	expect(codes.get('1212.2')).toBe(Date.UTC(1993, 0, 1));
	// 9999.9 only appears in an undated move, so it falls back to its dataset's fetch time.
	expect(codes.get('9999.9')).toBe(Date.parse(JOBHOP_AT));
});

test('dates each transition by the quarter it landed in, keeping the raw window', () => {
	const moves = ofRel('transitioned_to');
	expect(moves).toHaveLength(3);
	const dated = moves.find((e) => e.data?.window === 'Q3 2000 -> Q4 2003');
	expect(dated?.validFrom).toBe(Date.UTC(2003, 9, 1));
	// An undated move carries no window and falls back to its endpoints.
	const undated = moves.find((e) => e.data?.window === undefined);
	expect(undated?.validFrom).toBe(Date.parse(JOBHOP_AT));
});

test('crosses the O*NET ⇄ ESCO seam through the label crosswalk', () => {
	const [aligned] = ofRel('aligned_with');
	expect(aligned?.weight).toBeCloseTo(0.74);
	expect(aligned?.data).toEqual({ method: 'fuzzy' });
	expect(plan.types.get(aligned?.src as string)).toBe('occupation');
	expect(plan.types.get(aligned?.dst as string)).toBe('occupation_code');
});

test('crosses the O*NET ⇄ Nesta skill seam', () => {
	const [similar] = ofRel('similar_to');
	expect(similar?.weight).toBeCloseTo(0.77);
	expect(plan.types.get(similar?.src as string)).toBe('skill');
	expect(plan.types.get(similar?.dst as string)).toBe('skill');
});

test('counts crosswalk systems it does not model instead of dropping them silently', () => {
	expect(edgeSkipped['unmodelled crosswalk ISCO → SOC']).toBe(1);
});

test('carries the occupation-skill relation type onto the edge', () => {
	expect(
		ofRel('requires')
			.map((e) => e.data?.relation)
			.sort(),
	).toEqual(['essential', 'related']);
});

test('links every sourced row to its dataset, and nothing else', () => {
	// One occupation + two skills. Sources have no source; codes belong to no single dataset.
	expect(ofRel('sourced_from')).toHaveLength(3);
});

test('never lets an edge predate either endpoint', () => {
	for (const edge of all) {
		expect(edge.validFrom).toBeGreaterThanOrEqual(plan.startOf.get(edge.src) as number);
		expect(edge.validFrom).toBeGreaterThanOrEqual(plan.startOf.get(edge.dst) as number);
	}
});

test('every edge endpoint is a node in the plan, with a type the schema allows', () => {
	for (const edge of all) {
		const def = skillsSchema.edges[edge.rel as keyof typeof skillsSchema.edges] as {
			from?: string | readonly string[];
			to?: string | readonly string[];
		};
		for (const [id, spec] of [
			[edge.src, def.from],
			[edge.dst, def.to],
		] as const) {
			const type = plan.types.get(id);
			expect(type).toBeDefined();
			if (spec === undefined) continue;
			expect(typeof spec === 'string' ? [spec] : [...spec]).toContain(type as string);
		}
	}
});

test('mints a distinct id for every node and edge', () => {
	const ids = [...plan.nodes.map((n) => n.id), ...all.map((e) => e.id)];
	expect(new Set(ids).size).toBe(ids.length);
});

test('every node validates against the declared schema', () => {
	for (const node of plan.nodes) {
		expect(() =>
			skillsSchema.nodes[node.type as keyof typeof skillsSchema.nodes].parse(node.data),
		).not.toThrow();
	}
});

test('is deterministic — the same database yields the same ids', async () => {
	const again = fixture('again');
	const plan2 = buildNodes(again);
	const { all: all2 } = await collect(again, plan2);
	expect(plan2.nodes.map((n) => n.id)).toEqual(plan.nodes.map((n) => n.id));
	expect(all2.map((e) => e.id)).toEqual(all.map((e) => e.id));
	again.close();
});

test('hands out batches of the requested size, so memory does not track corpus size', async () => {
	const small = fixture('batched');
	const planSmall = buildNodes(small);
	const { batches, edges } = await collect(small, planSmall, 2);
	expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(2);
	expect(batches.flat()).toHaveLength(edges);
	small.close();
});

// --- the real collector database, when it is present -------------------------------------------

const REAL = process.env.COLLECTOR_DB ?? '../../../skill-collector/skills_graph.db';

test.skipIf(!existsSync(REAL))(
	"builds the real collector database's nodes, and its first edge batch resolves",
	async () => {
		const real = new Database(REAL, { readonly: true });
		const realPlan = buildNodes(real);
		expect(realPlan.nodes.filter((n) => n.type === 'occupation').length).toBeGreaterThan(500);
		expect(realPlan.nodes.filter((n) => n.type === 'occupation_code').length).toBeGreaterThan(500);
		expect(realPlan.nodes.filter((n) => n.type === 'skill').length).toBeGreaterThan(5_000);

		// Stop after the first batch — the full walk is the build's job, not the test suite's.
		const stop = new Error('enough');
		let first: PlanEdge[] = [];
		await streamEdges(
			real,
			realPlan,
			async (batch) => {
				first = batch;
				throw stop;
			},
			5_000,
		).catch((e) => {
			if (e !== stop) throw e;
		});
		expect(first.length).toBe(5_000);
		for (const edge of first) {
			expect(realPlan.types.has(edge.src)).toBe(true);
			expect(realPlan.types.has(edge.dst)).toBe(true);
		}
		real.close();
	},
	60_000,
);
