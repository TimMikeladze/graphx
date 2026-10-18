import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from 'graphx/local';
import { init, Graph } from 'graphx';
import { schema } from '../src/schema';
import { syncRelease } from '../src/ingest';
import { DeckStore } from '../src/decks';
import { neighborhood, shortest } from '../src/graph';
import type { Runtime } from '../src/runtime';
import {
	filterGraph,
	mergeGraph,
	projectCards,
	layoutGraph,
	defaultGraphFilters,
	type GraphData,
} from '../src/graph-model';

async function withGraph(run: (runtime: Runtime) => Promise<void>) {
	const db = await openMemoryDb();
	await init(db);
	const card = (name: string, keywords: string[], subtypes: string[]) => [
		{
			name,
			type: 'Creature',
			types: ['Creature'],
			keywords,
			subtypes,
			colors: ['U'],
			colorIdentity: ['U'],
			manaValue: 2,
			text: '',
			identifiers: { scryfallOracleId: name.toLowerCase(), scryfallId: `${name}-image` },
		},
	];
	const release = await syncRelease(db, {
		meta: { date: '2026-10-18', version: 'test' },
		data: {
			Alpha: card('Alpha', ['Flying'], ['Frog']),
			Beta: card('Beta', ['Flying'], ['Wizard']),
			Gamma: card('Gamma', ['Haste'], ['Frog']),
			Delta: card('Delta', ['Haste'], ['Warrior']),
		},
	});
	const graph = new Graph(db, schema);
	const catalog = new Map(release.cards.map((c) => [c.id, c]));
	try {
		await run({
			db,
			graph,
			catalog,
			cards: release.cards,
			decks: new DeckStore(graph, catalog),
			status: async () => ({}),
		} as Runtime);
	} finally {
		await db.close();
	}
}

describe('graph payloads', () => {
	test('relation filtering excludes unrelated candidates and includes card image data', () =>
		withGraph(async (r) => {
			const result = await neighborhood(r, 'card:alpha', 'has_keyword', 8);
			expect(
				result.nodes
					.filter((n) => n.type === 'card')
					.map((n) => n.name)
					.sort(),
			).toEqual(['Alpha', 'Beta']);
			expect(result.nodes.find((n) => n.id === 'card:beta')?.card?.scryfallId).toBe('Beta-image');
			expect(result.edges.every((e) => e.rel === 'has_keyword')).toBe(true);
		}));
	test('multiple relations and card limits produce connected neighborhoods', () =>
		withGraph(async (r) => {
			const result = await neighborhood(r, 'card:alpha', 'has_keyword,has_subtype', 1);
			expect(result.nodes.filter((n) => n.type === 'card')).toHaveLength(2);
			expect(
				result.nodes.every(
					(n) =>
						n.id === 'card:alpha' || result.edges.some((e) => e.src === n.id || e.dst === n.id),
				),
			).toBe(true);
			await expect(neighborhood(r, 'card:alpha', 'unknown')).rejects.toThrow('Unknown relation');
		}));
	test('shortest paths include renderable cards and persisted edges outside a neighborhood', () =>
		withGraph(async (r) => {
			const result = await shortest(r, 'card:beta', 'card:delta');
			expect(result.hops).toBe(6);
			expect(result.nodes.find((n) => n.id === 'card:delta')?.card?.name).toBe('Delta');
			expect(result.edges).toHaveLength(6);
			for (let i = 1; i < result.path.length; i++) {
				const a = result.path[i - 1]!.id,
					b = result.path[i]!.id;
				expect(
					result.edges.some((e) => (e.src === a && e.dst === b) || (e.src === b && e.dst === a)),
				).toBe(true);
			}
		}));
});

describe('canvas graph model', () => {
	test('card projection removes cards disconnected when an expanded hub is filtered out', () => {
		const data: GraphData = {
			nodes: [
				{ id: 'r', type: 'card', name: 'Root' },
				{ id: 'b', type: 'card', name: 'Bridge' },
				{ id: 'c', type: 'card', name: 'Disconnected after projection' },
				{ id: 'first', type: 'role', name: 'First feature' },
				{ id: 'second', type: 'role', name: 'Second feature' },
			],
			edges: [
				{ id: 'r1', src: 'r', dst: 'first', rel: 'fills_role', data: {} },
				{ id: 'b1', src: 'b', dst: 'first', rel: 'fills_role', data: {} },
				{ id: 'b2', src: 'b', dst: 'second', rel: 'fills_role', data: {} },
				{ id: 'c2', src: 'c', dst: 'second', rel: 'fills_role', data: {} },
			],
			truncated: false,
		};
		const projected = projectCards(data, new Set(['r', 'hidden-expanded-hub']), 'r');
		expect(projected.nodes.map((n) => n.id)).toEqual(['r', 'b']);
		expect(projected.edges).toHaveLength(1);
	});
	test('combined filters preserve the root and prune disconnected features', () =>
		withGraph(async (r) => {
			const data = await neighborhood(r, 'card:alpha');
			const visible = filterGraph(data, 'card:alpha', {
				...defaultGraphFilters,
				query: 'beta',
				color: 'U',
				maxMana: '2',
			});
			expect(
				visible.nodes
					.filter((n) => n.type === 'card')
					.map((n) => n.name)
					.sort(),
			).toEqual(['Alpha', 'Beta']);
			expect(visible.nodes.some((n) => n.type === 'subtype' && n.name === 'Frog')).toBe(true);
			expect(
				filterGraph(data, 'card:alpha', { ...defaultGraphFilters, relations: [] }).nodes.map(
					(n) => n.id,
				),
			).toEqual(['card:alpha']);
			expect(
				filterGraph(data, 'card:alpha', { ...defaultGraphFilters, color: 'R' }).nodes.filter(
					(n) => n.type === 'card',
				),
			).toHaveLength(1);
		}));
	test('card projection labels links with shared evidence and preserves feature path links', () =>
		withGraph(async (r) => {
			const data = await neighborhood(r, 'card:alpha', 'has_keyword');
			const projected = projectCards(data, new Set(['card:alpha']), 'card:alpha');
			expect(projected.nodes.every((n) => n.type === 'card')).toBe(true);
			expect(projected.edges).toHaveLength(1);
			expect(projected.edges[0]?.evidence?.map((e) => e.name)).toEqual(['Flying']);
			expect(projected.edges[0]?.src).toBe('card:alpha');
		}));
	test('expansion deduplicates nodes and drops edges whose endpoints exceed the cap', () => {
		const data: GraphData = {
			nodes: [
				{ id: 'a', name: 'A', type: 'card' },
				{ id: 'b', name: 'B', type: 'role' },
			],
			edges: [{ id: 'ab', src: 'a', dst: 'b', rel: 'fills_role', data: {} }],
			truncated: false,
		};
		const merged = mergeGraph(
			data,
			{
				...data,
				nodes: [...data.nodes, { id: 'c', name: 'C', type: 'card' }],
				edges: [...data.edges, { id: 'cb', src: 'c', dst: 'b', rel: 'fills_role', data: {} }],
			},
			2,
		);
		expect(merged.nodes).toHaveLength(2);
		expect(merged.edges).toHaveLength(1);
		expect(merged.truncated).toBe(true);
	});
	test('layout is deterministic, finite, and separates card rectangles', () =>
		withGraph(async (r) => {
			const graph = await neighborhood(r, 'card:alpha');
			const positions = layoutGraph(graph.nodes, 'card:alpha');
			expect(positions).toEqual(layoutGraph(graph.nodes, 'card:alpha'));
			for (const point of positions.values())
				expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
			const cards = graph.nodes.filter((n) => n.type === 'card');
			for (let a = 0; a < cards.length; a++)
				for (let b = a + 1; b < cards.length; b++) {
					const p = positions.get(cards[a]!.id)!,
						q = positions.get(cards[b]!.id)!;
					expect(Math.abs(p.x - q.x) >= 180 || Math.abs(p.y - q.y) >= 280).toBe(true);
				}
		}));
});
