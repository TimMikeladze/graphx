import { createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({ type: z.string() }),
		person: z.object({ name: z.string() }),
	},
	edges: { knows: { from: 'person', to: 'person' }, owns: { from: 'person', to: 'device' } },
});

async function graph() {
	const raw = createClient({ url: ':memory:' });
	await init(raw);
	return new Graph(raw, SCHEMA);
}

test('listNodes returns all live nodes ordered by id with nextCursor=null when they fit', async () => {
	const g = await graph();
	const a = await g.addNode({ kind: 'person', props: { name: 'a' } });
	const b = await g.addNode({ kind: 'device', props: { type: 'router' } });
	const page = await g.listNodes();
	expect(page.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
	expect(page.nextCursor).toBeNull();
	g.raw.close();
});

test('listNodes filters by kind', async () => {
	const g = await graph();
	await g.addNode({ kind: 'person', props: { name: 'a' } });
	const d = await g.addNode({ kind: 'device', props: { type: 'router' } });
	const page = await g.listNodes({ kind: 'device' });
	expect(page.nodes.map((n) => n.id)).toEqual([d.id]);
	g.raw.close();
});

test('listNodes full-text filters on body via FTS', async () => {
	const g = await graph();
	const hit = await g.addNode({ kind: 'device', props: { type: 'router' }, body: 'mercury gateway' });
	await g.addNode({ kind: 'device', props: { type: 'switch' }, body: 'venus relay' });
	const page = await g.listNodes({ q: 'mercury' });
	expect(page.nodes.map((n) => n.id)).toEqual([hit.id]);
	g.raw.close();
});

test('listNodes keyset-paginates with cursor', async () => {
	const g = await graph();
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) ids.push((await g.addNode({ kind: 'person', props: { name: `p${i}` } })).id);
	ids.sort();
	const p1 = await g.listNodes({ limit: 2 });
	expect(p1.nodes.map((n) => n.id)).toEqual(ids.slice(0, 2));
	expect(p1.nextCursor).not.toBeNull();
	const p2 = await g.listNodes({ limit: 2, cursor: p1.nextCursor! });
	expect(p2.nodes.map((n) => n.id)).toEqual(ids.slice(2));
	expect(p2.nextCursor).toBeNull();
	g.raw.close();
});

test('listNodes maxRows cap bounds the page', async () => {
	const g = await graph();
	for (let i = 0; i < 5; i++) await g.addNode({ kind: 'person', props: { name: `p${i}` } });
	const page = await g.listNodes({ limits: { maxRows: 2 } });
	expect(page.nodes.length).toBe(2);
	g.raw.close();
});

test('graphSlice returns the node set and only edges with both endpoints inside it', async () => {
	const g = await graph();
	const p1 = await g.addNode({ kind: 'person', props: { name: 'p1' } });
	const p2 = await g.addNode({ kind: 'person', props: { name: 'p2' } });
	const d1 = await g.addNode({ kind: 'device', props: { type: 'router' } });
	await g.addEdge({ rel: 'knows', src: p1.id, dst: p2.id });
	await g.addEdge({ rel: 'owns', src: p1.id, dst: d1.id });

	// Unfiltered: all 3 nodes, both edges.
	const all = await g.graphSlice();
	expect(all.nodes.map((n) => n.id).sort()).toEqual([p1.id, p2.id, d1.id].sort());
	expect(all.links.map((l) => l.rel).sort()).toEqual(['knows', 'owns']);
	expect(all.truncated).toBe(false);

	// kind=person drops d1, so the `owns` edge (endpoint d1 outside the set) is excluded.
	const persons = await g.graphSlice({ kind: 'person' });
	expect(persons.nodes.map((n) => n.id).sort()).toEqual([p1.id, p2.id].sort());
	expect(persons.links.map((l) => l.rel)).toEqual(['knows']);
	g.raw.close();
});

test('graphSlice links carry Cosmograph source/target/weight', async () => {
	const g = await graph();
	const p1 = await g.addNode({ kind: 'person', props: { name: 'p1' } });
	const p2 = await g.addNode({ kind: 'person', props: { name: 'p2' } });
	await g.addEdge({ rel: 'knows', src: p1.id, dst: p2.id, weight: 3 });
	const slice = await g.graphSlice();
	expect(slice.links[0]).toMatchObject({ source: p1.id, target: p2.id, rel: 'knows', weight: 3 });
	g.raw.close();
});

test('graphSlice sets truncated when the node set hits maxRows', async () => {
	const g = await graph();
	for (let i = 0; i < 5; i++) await g.addNode({ kind: 'person', props: { name: `p${i}` } });
	const slice = await g.graphSlice({ limits: { maxRows: 2 } });
	expect(slice.nodes.length).toBe(2);
	expect(slice.truncated).toBe(true);
	g.raw.close();
});

test('graphSlice with an unmatched full-text query returns empty', async () => {
	const g = await graph();
	await g.addNode({ kind: 'person', props: { name: 'p1' }, body: 'hello' });
	const slice = await g.graphSlice({ q: 'zzzznomatch' });
	expect(slice.nodes).toEqual([]);
	expect(slice.links).toEqual([]);
	g.raw.close();
});
