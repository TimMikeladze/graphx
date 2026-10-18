import { init, Graph, type DbClient } from 'graphx';
import { openLocalDb } from 'graphx/local';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { schema, type Card } from './schema';
import { readRelease, syncRelease } from './ingest';
import { DeckStore } from './decks';
import { CatalogStore } from './library';
import { syncLibraryGraph } from './library-graph';
export interface Runtime {
	db: DbClient;
	graph: Graph<typeof schema>;
	cards: Card[];
	catalog: Map<string, Card>;
	decks: DeckStore;
	library?: CatalogStore;
	status: () => Promise<Record<string, unknown>>;
}
export function runtime(force = false): Promise<Runtime> {
	const g = globalThis as typeof globalThis & {
		__mtg?: Promise<Runtime>;
		__mtgCatalogStamp?: string;
	};
	let stamp = 'missing';
	try {
		const s = statSync(join(process.cwd(), 'catalog.db'));
		stamp = `${s.ino}:${s.mtimeMs}`;
	} catch {}
	if (force || (g.__mtgCatalogStamp !== undefined && g.__mtgCatalogStamp !== stamp)) delete g.__mtg;
	g.__mtgCatalogStamp = stamp;
	return (g.__mtg ??= boot(force).catch((e) => {
		delete g.__mtg;
		throw e;
	}));
}
async function boot(force: boolean): Promise<Runtime> {
	const root = process.cwd();
	const db = await openLocalDb(join(root, 'mtg.db'));
	await init(db);
	const graph = new Graph(db, schema);
	const release = await readRelease(root);
	const meta = await graph.getNode('dataset:mtgjson');
	const coverage = release.coverage ?? 'full';
	if (
		force ||
		!meta ||
		meta.type !== 'dataset' ||
		meta.data.version !== release.meta.version ||
		meta.data.coverage !== coverage ||
		meta.data.name !== 'MTGJSON / AtomicCards · schema 2'
	) {
		console.log('[mtg] Importing MTGJSON graph');
		const result = await syncRelease(db, release);
		console.log(`[mtg] ${result.cards.length} cards, ${result.edges.length} relationships`);
	}
	const library = new CatalogStore(join(root, 'catalog.db'));
	await syncLibraryGraph(db, library, force);
	const cards = (await db.execute("SELECT data FROM nodes WHERE type='card'")).rows.map(
		(r) => JSON.parse(String(r.data)) as Card,
	);
	const catalog = new Map(cards.map((c) => [c.id, c]));
	const decks = new DeckStore(graph, catalog);
	if (!(await decks.list()).length) {
		const byName = new Map(cards.map((c) => [c.name, c]));
		const quantities: [number, string][] = [
			[4, 'Nethergoyf'],
			[4, 'Psychic Frog'],
			[4, 'Orcish Bowmasters'],
			[2, 'Murktide Regent'],
			[4, 'Thoughtseize'],
			[4, 'Fatal Push'],
			[4, 'Counterspell'],
			[4, 'Consider'],
			[2, 'Unearth'],
			[2, 'Spell Pierce'],
			[2, 'Drown in the Loch'],
			[4, 'Polluted Delta'],
			[4, 'Watery Grave'],
			[4, 'Darkslick Shores'],
			[4, 'Island'],
			[4, 'Swamp'],
			[2, 'Undercity Sewers'],
			[2, 'Misty Rainforest'],
		];
		const entries = quantities.flatMap(([quantity, name]) => {
			const c = byName.get(name);
			return c ? [{ cardId: c.id, quantity, board: 'main' as const }] : [];
		});
		await decks.create({ name: 'Dimir tempo', format: 'modern', commanderId: null, entries });
	}
	return {
		db,
		graph,
		cards,
		catalog,
		decks,
		library,
		status: async () => {
			const metadata = await graph.getNode('dataset:mtgjson');
			const counts = await db.execute(
				'SELECT (SELECT count(*) FROM nodes) AS nodes, (SELECT count(*) FROM edges) AS edges',
			);
			const installed = library.coverage();
			const matches =
				metadata?.type === 'dataset' &&
				installed.release?.version === metadata.data.version &&
				installed.release?.date === metadata.data.date;
			const catalogCoverage = {
				...installed,
				complete: installed.complete && matches,
				issues: [
					...installed.issues,
					...(installed.complete && !matches
						? ['Oracle graph and catalog releases differ. Run bun run ingest.']
						: []),
				],
			};
			return {
				dataset: {
					...metadata?.data,
					cards: cards.length,
					coverage: catalogCoverage.complete
						? 'complete'
						: metadata?.type === 'dataset' && metadata.data.coverage === 'snapshot'
							? 'snapshot'
							: 'oracle-only',
				},
				coverage: catalogCoverage,
				...counts.rows[0],
				engine: 'GraphX / libSQL',
				mode: 'local single-user',
				roleRuleVersion: 1,
			};
		},
	};
}
