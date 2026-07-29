import { describe, expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { FOREVER } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { createDuckClient } from '../src/duck.ts';
import { Graph } from '../src/graph.ts';
import { journey } from '../src/journey.ts';
import { match } from '../src/pattern.ts';
import { init } from '../src/schema.ts';

// T11 — the journey/pattern duckdb arms, exercised against a real DuckDB client (not a
// fake-client guard test — journey.ts/pattern.ts compile real recursive-CTE SQL that only a
// live engine can validate). bulk.ts is DELIBERATELY untouched: its version-row INSERTs
// target `node_versions`/`edge_versions`, which duckdbSchema (T9) makes UNION ALL VIEWS —
// DuckDB refuses INSERT into those ("Catalog Error: ... is not an table"). The same is true
// of every Graph write path (addNode/addEdge/updateNode/deleteNode/deleteEdge), so fixtures
// here are seeded with raw SQL into the live tables directly, matching the convention
// duck-schema.test.ts and p7-journey.test.ts already use — never via `g.addNode`/`g.addEdge`.
// See duck-guards.test.ts for the pinned bulkLoad guard and the report for the escalation.

const SCHEMA = defineGraphSchema({
	nodes: {
		Doc: z.object({ slug: z.string().optional(), rank: z.number().optional(), i: z.number().optional() }),
	},
	edges: {
		next: { from: 'Doc', to: 'Doc' },
	},
});

async function graph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const client = createDuckClient();
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
}

/** Seed a live node directly (node_identity + nv_live) — bypasses Graph.addNode (see header). */
async function seedNode(
	client: DbClient,
	id: string,
	type: string,
	data: Record<string, unknown>,
): Promise<void> {
	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	await client.execute({
		sql: `INSERT INTO nv_live (id, type, data, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)`,
		args: [id, type, JSON.stringify(data), 0, FOREVER],
	});
}

/** Seed a live edge directly (edge_identity + ev_live) — bypasses Graph.addEdge (see header). */
async function seedEdge(
	client: DbClient,
	src: string,
	dst: string,
	rel: string,
	validFrom = 0,
): Promise<void> {
	const id = ulid();
	await client.execute({ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: [id] });
	await client.execute({
		sql: `INSERT INTO ev_live (id, src, dst, rel, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)`,
		args: [id, src, dst, rel, validFrom, FOREVER],
	});
}

describe('duckdb query paths', () => {
	test('a pattern .where() on a string prop matches', async () => {
		const { client } = await graph();
		await seedNode(client, ulid(), 'Doc', { slug: 'alpha' });
		await seedNode(client, ulid(), 'Doc', { slug: 'beta' });
		const q = await match(SCHEMA, client).node('d', 'Doc').where('d', 'slug', 'alpha').select('d');
		const rows = await q.run();
		expect(rows).toHaveLength(1);
		await client.end();
	});

	test('a pattern .where() on a numeric prop matches', async () => {
		const { client } = await graph();
		await seedNode(client, ulid(), 'Doc', { rank: 3 });
		const q = await match(SCHEMA, client).node('d', 'Doc').where('d', 'rank', 3).select('d');
		const rows = await q.run();
		expect(rows).toHaveLength(1);
		await client.end();
	});

	test('keyset pagination returns every row exactly once', async () => {
		const { client, g } = await graph();
		for (let i = 0; i < 7; i++) await seedNode(client, ulid(), 'Doc', { i });
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const r = await g.listNodes({ type: 'Doc', limit: 3, cursor });
			for (const n of r.nodes) {
				expect(seen.has(n.id)).toBe(false);
				seen.add(n.id);
			}
			if (!r.nextCursor) break;
			cursor = r.nextCursor;
		}
		expect(seen.size).toBe(7);
		await client.end();
	});

	test('journey walks a chain', async () => {
		const { client } = await graph();
		const a = ulid();
		const b = ulid();
		const c = ulid();
		await seedNode(client, a, 'Doc', {});
		await seedNode(client, b, 'Doc', {});
		await seedNode(client, c, 'Doc', {});
		await seedEdge(client, a, b, 'next');
		await seedEdge(client, b, c, 'next');
		const hops = await journey(client, { start: a, from: 0, rels: ['next'], maxDepth: 3 });
		expect(hops.map((h) => h.id)).toContain(c);
		await client.end();
	});

	// pattern.ts's row-value keyset takes an OR-form on duckdb (unverified row-value
	// comparison there — see pattern.ts's keysetPredicate). It is generalized over however
	// many aliases `.select(...)` picks, so both arities get their own page-boundary
	// no-dup/no-skip test: a hardcoded 2-column form would emit invalid SQL for the 1-alias
	// case (referencing an undefined second column), and only running this ad hoc — rather
	// than as a committed test — is exactly the gap that would let a page-boundary bug through.

	test('pattern .page() keysets a single-alias result with no overlap or skip', async () => {
		const { client } = await graph();
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const id = ulid();
			await seedNode(client, id, 'Doc', { i });
			ids.push(id);
		}
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const q = await match(SCHEMA, client).node('d', 'Doc').select('d');
			const p = await q.page({ limit: 2, cursor });
			for (const row of p.rows) {
				expect(seen.has(row.d.id)).toBe(false);
				seen.add(row.d.id);
			}
			if (!p.nextCursor) break;
			cursor = p.nextCursor;
		}
		expect(seen).toEqual(new Set(ids));
		await client.end();
	});

	test('pattern .page() keysets a two-alias composite key with no overlap or skip', async () => {
		const { client } = await graph();
		const hub = ulid();
		await seedNode(client, hub, 'Doc', {});
		const neighbors: string[] = [];
		for (let i = 0; i < 5; i++) {
			const n = ulid();
			await seedNode(client, n, 'Doc', {});
			await seedEdge(client, hub, n, 'next');
			neighbors.push(n);
		}
		const seenPairs: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const q = await match(SCHEMA, client).node('a', 'Doc').out('next').node('b', 'Doc').select('a', 'b');
			const p = await q.page({ limit: 2, cursor });
			for (const row of p.rows) {
				expect(row.a.id).toBe(hub);
				seenPairs.push(row.b.id);
			}
			if (!p.nextCursor) break;
			cursor = p.nextCursor;
		}
		expect(new Set(seenPairs)).toEqual(new Set(neighbors));
		expect(seenPairs.length).toBe(5);
		await client.end();
	});
});
