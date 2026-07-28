import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { makeTestDb } from './harness.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({ type: z.string() }),
		person: z.object({ name: z.string() }),
	},
	edges: { knows: { from: 'person', to: 'person' }, owns: { from: 'person', to: 'device' } },
});

async function graph() {
	const raw = makeTestDb().client;
	await init(raw);
	return new Graph(raw, SCHEMA);
}

test('listNodes returns all live nodes ordered by id with nextCursor=null when they fit', async () => {
	const g = await graph();
	const a = await g.addNode({ type: 'person', data: { name: 'a' } });
	const b = await g.addNode({ type: 'device', data: { type: 'router' } });
	const page = await g.listNodes();
	expect(page.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
	expect(page.nextCursor).toBeNull();
	g.raw.close();
});

test('listNodes filters by type', async () => {
	const g = await graph();
	await g.addNode({ type: 'person', data: { name: 'a' } });
	const d = await g.addNode({ type: 'device', data: { type: 'router' } });
	const page = await g.listNodes({ type: 'device' });
	expect(page.nodes.map((n) => n.id)).toEqual([d.id]);
	g.raw.close();
});

test('listNodes full-text filters on body via FTS', async () => {
	const g = await graph();
	const hit = await g.addNode({ type: 'device', data: { type: 'router' }, body: 'mercury gateway' });
	await g.addNode({ type: 'device', data: { type: 'switch' }, body: 'venus relay' });
	const page = await g.listNodes({ q: 'mercury' });
	expect(page.nodes.map((n) => n.id)).toEqual([hit.id]);
	g.raw.close();
});

test('listNodes keyset-paginates with cursor', async () => {
	const g = await graph();
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
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
	for (let i = 0; i < 5; i++) await g.addNode({ type: 'person', data: { name: `p${i}` } });
	const page = await g.listNodes({ limits: { maxRows: 2 } });
	expect(page.nodes.length).toBe(2);
	g.raw.close();
});

test('graphSlice returns the node set and only edges with both endpoints inside it', async () => {
	const g = await graph();
	const p1 = await g.addNode({ type: 'person', data: { name: 'p1' } });
	const p2 = await g.addNode({ type: 'person', data: { name: 'p2' } });
	const d1 = await g.addNode({ type: 'device', data: { type: 'router' } });
	await g.addEdge({ rel: 'knows', src: p1.id, dst: p2.id });
	await g.addEdge({ rel: 'owns', src: p1.id, dst: d1.id });

	// Unfiltered: all 3 nodes, both edges.
	const all = await g.graphSlice();
	expect(all.nodes.map((n) => n.id).sort()).toEqual([p1.id, p2.id, d1.id].sort());
	expect(all.links.map((l) => l.rel).sort()).toEqual(['knows', 'owns']);
	expect(all.truncated).toBe(false);

	// type=person drops d1, so the `owns` edge (endpoint d1 outside the set) is excluded.
	const persons = await g.graphSlice({ type: 'person' });
	expect(persons.nodes.map((n) => n.id).sort()).toEqual([p1.id, p2.id].sort());
	expect(persons.links.map((l) => l.rel)).toEqual(['knows']);
	g.raw.close();
});

test('graphSlice links carry Cosmograph source/target/weight', async () => {
	const g = await graph();
	const p1 = await g.addNode({ type: 'person', data: { name: 'p1' } });
	const p2 = await g.addNode({ type: 'person', data: { name: 'p2' } });
	await g.addEdge({ rel: 'knows', src: p1.id, dst: p2.id, weight: 3 });
	const slice = await g.graphSlice();
	expect(slice.links[0]).toMatchObject({ source: p1.id, target: p2.id, rel: 'knows', weight: 3 });
	g.raw.close();
});

test('graphSlice sets truncated when the node set hits maxRows', async () => {
	const g = await graph();
	for (let i = 0; i < 5; i++) await g.addNode({ type: 'person', data: { name: `p${i}` } });
	const slice = await g.graphSlice({ limits: { maxRows: 2 } });
	expect(slice.nodes.length).toBe(2);
	expect(slice.truncated).toBe(true);
	g.raw.close();
});

test('graphSlice nodes carry a display label drawn from data', async () => {
	const g = await graph();
	// `person` has a `name`; `device` has neither name nor title, so it gets no label.
	const p = await g.addNode({ type: 'person', data: { name: 'Ada Lovelace' } });
	const d = await g.addNode({ type: 'device', data: { type: 'router' } });
	const slice = await g.graphSlice();
	const byId = new Map(slice.nodes.map((n) => [n.id, n]));
	expect(byId.get(p.id)?.label).toBe('Ada Lovelace');
	expect(byId.get(d.id)?.label).toBeUndefined();
	// The label is the ONLY part of data the slice exposes.
	expect(byId.get(p.id)).toEqual({ id: p.id, type: 'person', label: 'Ada Lovelace' });
	g.raw.close();
});

test('graphSlice labels are trimmed and capped', async () => {
	const raw = makeTestDb().client;
	await init(raw);
	const schema = defineGraphSchema({ nodes: { doc: z.object({ title: z.string() }) }, edges: {} });
	const g = new Graph(raw, schema);
	const padded = await g.addNode({ type: 'doc', data: { title: '   spaced   ' } });
	const long = await g.addNode({ type: 'doc', data: { title: 'x'.repeat(200) } });
	const byId = new Map((await g.graphSlice()).nodes.map((n) => [n.id, n]));
	expect(byId.get(padded.id)?.label).toBe('spaced');
	expect(byId.get(long.id)?.label?.length).toBe(80);
	raw.close();
});

test('graphSlice nodes carry an image URL drawn from data', async () => {
	const raw = makeTestDb().client;
	await init(raw);
	const schema = defineGraphSchema({
		nodes: {
			person: z.object({ name: z.string(), avatar: z.string().optional() }),
			doc: z.object({ title: z.string() }),
		},
		edges: {},
	});
	const g = new Graph(raw, schema);
	const withImage = await g.addNode({
		type: 'person',
		data: { name: 'Ada', avatar: 'https://cdn.example/ada.png' },
	});
	const without = await g.addNode({ type: 'doc', data: { title: 'notes' } });
	const byId = new Map((await g.graphSlice()).nodes.map((n) => [n.id, n]));
	expect(byId.get(withImage.id)?.image).toBe('https://cdn.example/ada.png');
	expect(byId.get(without.id)?.image).toBeUndefined();
	raw.close();
});

test('graphSlice image keys are tried in priority order', async () => {
	const raw = makeTestDb().client;
	await init(raw);
	const schema = defineGraphSchema({
		nodes: { person: z.object({ image: z.string(), avatar: z.string() }) },
		edges: {},
	});
	const g = new Graph(raw, schema);
	const n = await g.addNode({
		type: 'person',
		data: { image: 'https://cdn.example/first.png', avatar: 'https://cdn.example/second.png' },
	});
	const byId = new Map((await g.graphSlice()).nodes.map((x) => [x.id, x]));
	expect(byId.get(n.id)?.image).toBe('https://cdn.example/first.png');
	raw.close();
});

test('graphSlice drops image URLs that are not http(s), and over-long ones', async () => {
	const raw = makeTestDb().client;
	await init(raw);
	const schema = defineGraphSchema({
		nodes: { person: z.object({ name: z.string(), image: z.string() }) },
		edges: {},
	});
	const g = new Graph(raw, schema);
	// A node's `data` is author-controlled and its image lands in an `<img src>`, so anything
	// that is not a plain http(s) URL must never leave the server.
	const script = await g.addNode({
		type: 'person',
		data: { name: 'x', image: 'javascript:alert(1)' },
	});
	const upper = await g.addNode({
		type: 'person',
		data: { name: 'x', image: 'JavaScript:alert(1)' },
	});
	const dataUri = await g.addNode({
		type: 'person',
		data: { name: 'x', image: 'data:image/png;base64,iVBORw0KGgo=' },
	});
	const relative = await g.addNode({ type: 'person', data: { name: 'x', image: '/avatars/a.png' } });
	const long = await g.addNode({
		type: 'person',
		data: { name: 'x', image: `https://cdn.example/${'x'.repeat(600)}.png` },
	});
	const byId = new Map((await g.graphSlice()).nodes.map((n) => [n.id, n]));
	for (const n of [script, upper, dataUri, relative, long]) {
		expect(byId.get(n.id)?.image).toBeUndefined();
	}
	raw.close();
});

test('graphSlice with an unmatched full-text query returns empty', async () => {
	const g = await graph();
	await g.addNode({ type: 'person', data: { name: 'p1' }, body: 'hello' });
	const slice = await g.graphSlice({ q: 'zzzznomatch' });
	expect(slice.nodes).toEqual([]);
	expect(slice.links).toEqual([]);
	g.raw.close();
});
