import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, CatalogStore, copyPublishedDeck } from '../src/library';
import { openMemoryDb } from 'graphx/local';
import { init, Graph } from 'graphx';
import { schema } from '../src/schema';
import { syncRelease } from '../src/ingest';
import { DeckStore } from '../src/decks';
const meta = { date: '2026-10-18', version: 'fixture' };
const island = {
	name: 'Island',
	types: ['Land'],
	type: 'Basic Land — Island',
	supertypes: ['Basic'],
	printings: ['LEA'],
	identifiers: { scryfallOracleId: 'island' },
};
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'mtg-library-'));
	await mkdir(join(root, 'data', 'decks'), { recursive: true });
	const sources: Record<string, unknown> = {
		AtomicCards: { Island: [island] },
		AllPrintings: {
			LEA: {
				code: 'LEA',
				name: 'Limited Edition Alpha',
				type: 'core',
				releaseDate: '1993-08-05',
				cards: [
					{
						...island,
						uuid: 'printing-1',
						number: '1',
						foreignData: [{ language: 'French', name: 'Île' }],
					},
				],
				tokens: [{ uuid: 'token-1', name: 'Token' }],
				sealedProduct: [
					{ uuid: 'box-1', name: 'Starter', contents: { deck: [{ name: 'Alpha' }] } },
				],
				booster: { default: { boosters: [] } },
			},
			EMPTY: { code: 'EMPTY', name: 'Empty set', type: 'memorabilia', cards: [] },
		},
		SetList: [
			{ code: 'LEA', name: 'Limited Edition Alpha' },
			{ code: 'EMPTY', name: 'Empty set' },
		],
		DeckList: [{ fileName: 'alpha', name: 'Alpha', code: 'LEA' }],
		AllIdentifiers: {
			'printing-1': { ...island, uuid: 'printing-1', setCode: 'LEA' },
			'token-1': { name: 'Token', uuid: 'token-1', setCode: 'LEA' },
		},
		AllPrices: { 'printing-1': { paper: { test: { retail: { normal: { '2026-10-17': 2 } } } } } },
		AllPricesToday: {
			'printing-1': { paper: { test: { retail: { normal: { '2026-10-18': 3 } } } } },
		},
		TcgplayerSkus: { 'printing-1': [{ skuId: 1, finish: 'NORMAL' }] },
		CardmarketIdentifiers: {
			expansions: { '1': { name: 'Alpha', setCodes: ['LEA'] } },
			products: { '123': { name: 'Island', expansionId: 1, uuids: ['printing-1'] } },
		},
		CardTypes: { creature: { subTypes: ['Human'] } },
		Keywords: { keywordAbilities: ['Flying'] },
		EnumValues: { card: { rarity: ['common'] } },
		CompiledList: ['AllPrintings'],
		Meta: meta,
	};
	const datasets = [];
	for (const [name, data] of Object.entries(sources)) {
		await writeFile(join(root, 'data', `${name}.json`), JSON.stringify({ meta, data }));
		datasets.push({
			name,
			file: `${name}.json`,
			sha256: 'a'.repeat(64),
			date: meta.date,
			version: meta.version,
			bytes: 100,
			source: `https://mtgjson.com/api/v5/${name}.json.xz`,
		});
	}
	const deck = {
		code: 'LEA',
		name: 'Alpha',
		type: 'Starter',
		releaseDate: '1993-08-05',
		mainBoard: [{ ...island, uuid: 'printing-1', count: 24 }],
		sideBoard: [{ ...island, uuid: 'printing-1', count: 1 }],
		commander: [],
		tokens: [{ uuid: 'token-1', name: 'Token' }],
		sealedProductUuids: ['box-1'],
	};
	await writeFile(join(root, 'data', 'decks', 'alpha.json'), JSON.stringify({ meta, data: deck }));
	datasets.push({
		name: 'AllDeckFiles',
		file: 'decks',
		sha256: 'b'.repeat(64),
		date: meta.date,
		version: meta.version,
		bytes: 100,
		source: 'https://mtgjson.com/api/v5/AllDeckFiles.tar.xz',
	});
	await writeFile(join(root, 'data', 'manifest.json'), JSON.stringify({ release: meta, datasets }));
	return { root, deck };
}
test('imports every source record losslessly, including sets without oracle printings; exposes all pages', async () => {
	const { root, deck } = await fixture();
	const store = new CatalogStore(join(root, 'catalog.db'));
	try {
		expect(store.coverage().complete).toBe(false);
		await buildCatalog(root);
		const coverage = store.coverage();
		expect(coverage.complete).toBe(true);
		expect(coverage.datasets).toHaveLength(15);
		expect(coverage.counts).toMatchObject({
			sets: 2,
			decks: 1,
			printings: 1,
			tokens: 1,
			sealed: 1,
			prices: 1,
			skus: 1,
		});
		expect(store.list('sets', { limit: 1, page: 2 }).items).toHaveLength(1);
		expect(store.list('sets', { q: 'Empty' }).total).toBe(1);
		expect(store.summary('decks', 'alpha')?.name).toBe('Alpha');
		expect(store.summary('decks', 'missing')).toBeNull();
		expect(store.get('decks', 'alpha')).toMatchObject(deck);
		expect(store.get('printings', 'printing-1').foreignData).toEqual([
			{ language: 'French', name: 'Île' },
		]);
		expect(store.get('sets', 'LEA').booster).toEqual({ default: { boosters: [] } });
		expect(store.list('printings', { set: 'LEA' }).total).toBe(1);
		expect(store.list('cardmarket', { q: 'Island' }).total).toBe(1);
		expect(store.get('cardmarket', 'products:123').uuids).toEqual(['printing-1']);
		expect(store.list('prices', { q: 'Island', set: 'LEA' }).total).toBe(1);
		expect(() => store.list('sets', { page: 0 })).toThrow();
		expect(() => store.get('decks', 'missing')).toThrow();
		await buildCatalog(root);
		expect(store.coverage().counts.decks).toBe(1);
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('missing indexed decks abort publication and preserve the previous installed catalog', async () => {
	const { root } = await fixture();
	const store = new CatalogStore(join(root, 'catalog.db'));
	try {
		await buildCatalog(root);
		await writeFile(
			join(root, 'data', 'DeckList.json'),
			JSON.stringify({ meta, data: [{ fileName: 'alpha' }, { fileName: 'missing' }] }),
		);
		await expect(buildCatalog(root)).rejects.toThrow(/missing/i);
		expect(store.coverage().complete).toBe(true);
		expect(store.list('decks').total).toBe(1);
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('copy preserves quantities and sideboard; unsupported commanders are not silently lost', async () => {
	const { root } = await fixture();
	const store = new CatalogStore(join(root, 'catalog.db'));
	const db = await openMemoryDb();
	try {
		await init(db);
		await buildCatalog(root);
		const plan = await syncRelease(db, { meta, data: { Island: [island] } });
		const catalog = new Map(plan.cards.map((c) => [c.id, c]));
		const decks = new DeckStore(new Graph(db, schema), catalog);
		const copy = await copyPublishedDeck(store, 'alpha', 'modern', decks, catalog);
		expect(copy.entries).toEqual([
			{ cardId: 'card:island', quantity: 24, board: 'main' },
			{ cardId: 'card:island', quantity: 1, board: 'side' },
		]);
		const original = JSON.parse(await Bun.file(join(root, 'data', 'decks', 'alpha.json')).text());
		original.data.commander = [
			{ ...island, count: 1 },
			{ ...island, count: 1 },
		];
		await writeFile(join(root, 'data', 'decks', 'alpha.json'), JSON.stringify(original));
		await buildCatalog(root);
		await expect(copyPublishedDeck(store, 'alpha', 'commander', decks, catalog)).rejects.toThrow(
			/commander/i,
		);
		expect((await decks.list()).length).toBe(1);
	} finally {
		store.close();
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('library HTTP validates kind and pagination and serves source data', async () => {
	const { app } = await import('../src/api');
	const { root } = await fixture();
	const store = new CatalogStore(join(root, 'catalog.db'));
	const db = await openMemoryDb();
	const global = globalThis as typeof globalThis & { __mtg?: Promise<any> };
	const previous = global.__mtg;
	try {
		await init(db);
		await buildCatalog(root);
		const plan = await syncRelease(db, { meta, data: { Island: [island] } });
		const graph = new Graph(db, schema);
		const catalog = new Map(plan.cards.map((c) => [c.id, c]));
		const decks = new DeckStore(graph, catalog);
		global.__mtg = Promise.resolve({
			db,
			graph,
			cards: plan.cards,
			catalog,
			decks,
			library: store,
			status: async () => ({ dataset: plan.metadata }),
		});
		const req = (path: string) => app.request(`http://localhost/api/v1${path}`);
		expect((await req('/library/sets')).status).toBe(200);
		expect((await (await req('/library/sets?limit=1&page=2')).json()).items).toHaveLength(1);
		expect((await req('/library/sets?page=0')).status).toBe(400);
		expect((await req('/library/nope')).status).toBe(400);
		expect((await req('/library/sets/absent')).status).toBe(404);
		expect((await (await req('/coverage')).json()).complete).toBe(true);
		expect((await req('/library/decks/alpha/copy')).status).toBe(404);
	} finally {
		global.__mtg = previous;
		store.close();
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('complete library adds all set and published deck graph nodes without altering saved decks', async () => {
	const { syncLibraryGraph } = await import('../src/library-graph');
	const { root } = await fixture();
	const store = new CatalogStore(join(root, 'catalog.db'));
	const db = await openMemoryDb();
	try {
		await init(db);
		await buildCatalog(root);
		const plan = await syncRelease(db, { meta, data: { Island: [island] } });
		const graph = new Graph(db, schema);
		const catalog = new Map(plan.cards.map((c) => [c.id, c]));
		const decks = new DeckStore(graph, catalog);
		const saved = await decks.create({
			name: 'My deck',
			format: 'modern',
			entries: [],
			commanderId: null,
		});
		await syncLibraryGraph(db, store);
		expect((await graph.getNode('set:empty'))?.data.name).toBe('Empty set');
		expect((await graph.getNode('published_deck:alpha'))?.data.name).toBe('Alpha');
		expect(
			(await graph.listEdges({ src: 'published_deck:alpha', rel: 'published_contains' })).edges,
		).toHaveLength(2);
		const before = await decks.get(saved.id);
		await syncRelease(db, { meta, data: { Island: [island] } });
		await syncLibraryGraph(db, store, true);
		expect((await decks.get(saved.id)).revision).toBe(before.revision);
		expect((await decks.list()).length).toBe(1);
	} finally {
		store.close();
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('refreshing oracle data preserves user membership edges for cards found only in published decks', async () => {
	const { syncLibraryGraph } = await import('../src/library-graph');
	const { root } = await fixture();
	const store = new CatalogStore(join(root, 'catalog.db'));
	const db = await openMemoryDb();
	try {
		await init(db);
		const doc = JSON.parse(await Bun.file(join(root, 'data', 'decks', 'alpha.json')).text());
		doc.data.mainBoard.push({ name: 'Deck-only card', type: 'Creature', count: 1 });
		await writeFile(join(root, 'data', 'decks', 'alpha.json'), JSON.stringify(doc));
		await buildCatalog(root);
		await syncRelease(db, { meta, data: { Island: [island] } });
		await syncLibraryGraph(db, store);
		const graph = new Graph(db, schema);
		const rows = (await db.execute("SELECT data FROM nodes WHERE type='card'")).rows;
		const cards = rows.map((r) => JSON.parse(String(r.data)));
		const card = cards.find((c) => c.name === 'Deck-only card');
		const decks = new DeckStore(graph, new Map(cards.map((c) => [c.id, c])));
		expect(card.printings).toEqual(['LEA']);
		expect((await graph.listEdges({ src: card.id, rel: 'printed_in' })).edges).toHaveLength(1);
		const saved = await decks.create({
			name: 'Retain supplemental',
			format: 'modern',
			entries: [{ cardId: card.id, quantity: 1, board: 'main' }],
			commanderId: null,
		});
		await syncRelease(db, { meta, data: { Island: [island] } });
		expect(await graph.getNode(card.id)).not.toBeNull();
		expect((await graph.listEdges({ src: saved.id, rel: 'contains' })).edges).toHaveLength(1);
	} finally {
		store.close();
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('deck filenames compare canonically across macOS Unicode normalization', async () => {
	const { rename } = await import('node:fs/promises');
	const { root } = await fixture();
	const store = new CatalogStore(join(root, 'catalog.db'));
	try {
		await rename(
			join(root, 'data', 'decks', 'alpha.json'),
			join(root, 'data', 'decks', 'Cafe\u0301.json'),
		);
		await writeFile(
			join(root, 'data', 'DeckList.json'),
			JSON.stringify({ meta, data: [{ fileName: 'Café', code: 'LEA', name: 'Alpha' }] }),
		);
		await buildCatalog(root);
		expect(store.get('decks', 'Café').name).toBe('Alpha');
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('an oracle refresh invalidates published graph synchronization even when catalog bytes are unchanged', async () => {
	const { syncLibraryGraph } = await import('../src/library-graph');
	const { root } = await fixture();
	const store = new CatalogStore(join(root, 'catalog.db'));
	const db = await openMemoryDb();
	try {
		const file = join(root, 'data', 'decks', 'alpha.json');
		const doc = JSON.parse(await Bun.file(file).text());
		doc.data.mainBoard.push({ name: 'Supplemental card', type: 'Creature', count: 1 });
		await writeFile(file, JSON.stringify(doc));
		await init(db);
		await buildCatalog(root);
		await syncRelease(db, { meta, data: { Island: [island] } });
		await syncLibraryGraph(db, store);
		await syncRelease(db, { meta: { ...meta, version: 'next' }, data: { Island: [island] } });
		await syncLibraryGraph(db, store);
		const missing = (
			await db.execute(
				"SELECT count(*) AS n FROM edges e LEFT JOIN nodes n ON n.id=e.dst WHERE e.rel='published_contains' AND n.id IS NULL",
			)
		).rows[0];
		expect(Number(missing?.n)).toBe(0);
	} finally {
		store.close();
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
