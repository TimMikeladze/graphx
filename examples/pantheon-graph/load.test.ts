/**
 * The loader's contract, checked against a hand-built collector database rather than the real
 * one — so this runs anywhere, with no 30MB of scraped mythology required.
 *
 * The last test does use the real database when it happens to be there, because the properties
 * that matter (no dangling endpoints, no edge predating its endpoints) are worth asserting
 * against real data too.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { loadPantheon, type Plan } from './load.ts';
import { pantheonSchema } from './schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'pantheon-load-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';

/** A miniature `pantheon_graph.db`: two sources that disagree about one figure. */
function fixture(name: string): string {
	const path = join(dir, `${name}.db`);
	const db = new Database(path, { create: true });
	db.run(`
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT, url TEXT, license TEXT,
      access_method TEXT, last_fetched_at TEXT);
    CREATE TABLE pantheons (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT,
      name TEXT, culture TEXT, region TEXT, era TEXT);
    CREATE TABLE deities (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT,
      preferred_name TEXT, native_name TEXT, pantheon_id INTEGER, description TEXT,
      coverage_flag TEXT);
    CREATE TABLE domains (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE deity_domains (deity_id INTEGER, domain_id INTEGER, source_id INTEGER);
    CREATE TABLE deity_relations (id INTEGER PRIMARY KEY, from_deity_id INTEGER,
      to_deity_id INTEGER, relation_type TEXT, source_id INTEGER);
    CREATE TABLE equivalences (id INTEGER PRIMARY KEY, deity_a_id INTEGER, deity_b_id INTEGER,
      match_method TEXT, confidence REAL, source_id INTEGER);
  `);
	db.run(`INSERT INTO sources VALUES (1,'Wikidata','https://wikidata.org','CC0-1.0','sparql',?)`, [
		T1,
	]);
	db.run(`INSERT INTO sources VALUES (2,'DBpedia',NULL,'CC BY-SA 3.0','sparql',?)`, [T2]);
	db.run(`INSERT INTO pantheons VALUES (1,1,'Q1','Greek','Ancient Greek','Aegean','Bronze Age')`);
	db.run(`INSERT INTO pantheons VALUES (2,2,NULL,NULL,NULL,NULL,NULL)`); // unnamed ⇒ skipped
	db.run(`INSERT INTO deities VALUES (1,1,'Q1','Zeus','Ζεύς',1,'sky god','')`);
	db.run(`INSERT INTO deities VALUES (2,1,'Q2','Hera',NULL,1,NULL,NULL)`);
	db.run(`INSERT INTO deities VALUES (3,2,'dbp:Zeus','Zeus',NULL,NULL,'king of the gods',NULL)`);
	db.run(`INSERT INTO deities VALUES (4,1,'Q4',NULL,NULL,1,NULL,NULL)`); // unnamed ⇒ skipped
	db.run(`INSERT INTO domains VALUES (1,'sky'),(2,'marriage'),(3,'unclaimed')`);
	db.run(`INSERT INTO deity_domains VALUES (1,1,1),(2,2,1)`);
	db.run(`INSERT INTO deity_relations VALUES (1,1,2,'consort_of',1),(2,1,2,'rules_with',1)`);
	db.run(`INSERT INTO equivalences VALUES (1,1,3,'fuzzy',0.9,2)`);
	db.close();
	return path;
}

const plan = loadPantheon(fixture('basic'));

function ofType(p: Plan, type: string): Plan['nodes'] {
	return p.nodes.filter((n) => n.type === type);
}
function ofRel(p: Plan, rel: string): Plan['edges'] {
	return p.edges.filter((e) => e.rel === rel);
}

test('emits one node per named row, and skips the unnamed ones', () => {
	expect(ofType(plan, 'source')).toHaveLength(2);
	expect(ofType(plan, 'pantheon')).toHaveLength(1);
	expect(ofType(plan, 'deity')).toHaveLength(3);
	expect(plan.skipped['deity without a name']).toBe(1);
	expect(plan.skipped['pantheon without a name']).toBe(1);
});

test('only emits domains a deity claims', () => {
	expect(ofType(plan, 'domain').map((n) => n.data.label).sort()).toEqual(['marriage', 'sky']);
	expect(plan.skipped['domain no deity claims']).toBe(1);
});

test('keeps the sources unmerged — the same figure appears once per source', () => {
	const zeus = ofType(plan, 'deity').filter((n) => n.data.name === 'Zeus');
	expect(zeus.map((n) => n.data.source).sort()).toEqual(['DBpedia', 'Wikidata']);
});

test('records cross-source identity as an edge with its confidence, not a merge', () => {
	const [same] = ofRel(plan, 'same_as');
	expect(same?.weight).toBe(0.9);
	expect(same?.data).toEqual({ method: 'fuzzy' });
});

test('counts relation types it does not model instead of dropping them silently', () => {
	expect(ofRel(plan, 'consort_of')).toHaveLength(1);
	expect(plan.skipped["unmodelled relation type 'rules_with'"]).toBe(1);
});

test("dates every row from its own source's fetch time", () => {
	const [wikidata, dbpedia] = ofType(plan, 'source');
	expect(wikidata?.validFrom).toBe(Date.parse(T1));
	expect(dbpedia?.validFrom).toBe(Date.parse(T2));
	// The DBpedia Zeus is only known once DBpedia has been fetched.
	const late = ofType(plan, 'deity').find((n) => n.data.source === 'DBpedia');
	expect(late?.validFrom).toBe(Date.parse(T2));
});

test('never lets an edge predate either endpoint', () => {
	const start = new Map(plan.nodes.map((n) => [n.id, n.validFrom]));
	for (const edge of plan.edges) {
		expect(edge.validFrom).toBeGreaterThanOrEqual(start.get(edge.src) as number);
		expect(edge.validFrom).toBeGreaterThanOrEqual(start.get(edge.dst) as number);
	}
});

test('every edge endpoint is a node in the plan, with a type the schema allows', () => {
	for (const edge of plan.edges) {
		const def = pantheonSchema.edges[edge.rel as keyof typeof pantheonSchema.edges] as {
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

test('is deterministic — the same database yields the same ids', () => {
	const again = loadPantheon(fixture('again'));
	expect(again.nodes.map((n) => n.id)).toEqual(plan.nodes.map((n) => n.id));
	expect(again.edges.map((e) => e.id)).toEqual(plan.edges.map((e) => e.id));
});

test('mints a distinct id for every node and edge', () => {
	const ids = [...plan.nodes.map((n) => n.id), ...plan.edges.map((e) => e.id)];
	expect(new Set(ids).size).toBe(ids.length);
});

test('every node validates against the declared schema', () => {
	for (const node of plan.nodes) {
		expect(() =>
			pantheonSchema.nodes[node.type as keyof typeof pantheonSchema.nodes].parse(node.data),
		).not.toThrow();
	}
});

// --- the real collector database, when it is present -------------------------------------------

const REAL = process.env.COLLECTOR_DB ?? '../../../pantheon-collector/pantheon_graph.db';

test.skipIf(!existsSync(REAL))('loads the real collector database with no dangling edges', () => {
	const real = loadPantheon(REAL);
	expect(real.nodes.length).toBeGreaterThan(1_000);
	expect(real.edges.length).toBeGreaterThan(1_000);
	const start = new Map(real.nodes.map((n) => [n.id, n.validFrom]));
	for (const edge of real.edges) {
		expect(start.has(edge.src)).toBe(true);
		expect(start.has(edge.dst)).toBe(true);
		expect(edge.validFrom).toBeGreaterThanOrEqual(start.get(edge.src) as number);
		expect(edge.validFrom).toBeGreaterThanOrEqual(start.get(edge.dst) as number);
	}
});
