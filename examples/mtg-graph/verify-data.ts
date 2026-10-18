import { join, basename } from 'node:path';
import { openLocalDb } from 'graphx/local';
import { CatalogStore } from './src/library';
import { syncLibraryGraph } from './src/library-graph';
import { key } from './src/catalog';
const root = import.meta.dir;
const library = new CatalogStore(join(root, 'catalog.db'));
const db = await openLocalDb(join(root, 'mtg.db'));
try {
	const coverage = library.coverage();
	if (!coverage.complete) throw new Error(`Catalog is incomplete: ${coverage.issues.join('; ')}`);
	const expectedSets = new Set(
		(library.get('reference', 'SetList').data as { code: string }[]).map((s) => key('set', s.code)),
	);
	const expectedDecks = new Set(
		(library.get('reference', 'DeckList').data as { fileName: string }[]).map(
			(d) => `published_deck:${d.fileName.replace(/\.json$/, '').normalize('NFC')}`,
		),
	);
	for (const [type, expected] of [
		['set', expectedSets],
		['published_deck', expectedDecks],
	] as const) {
		const ids = (
			await db.execute({ sql: 'SELECT id FROM nodes WHERE type=?', args: [type] })
		).rows.map((r) => String(r.id));
		if (ids.length !== expected.size || ids.some((id) => !expected.has(id)))
			throw new Error(`Graph ${type} IDs differ from source index`);
	}
	let deckPayloads = 0;
	for (const file of new Bun.Glob('**/*.json').scanSync(join(root, 'data', 'decks'))) {
		const source = (await Bun.file(join(root, 'data', 'decks', file)).json()).data;
		const actual = library.get(
			'decks',
			basename(file)
				.replace(/\.json$/, '')
				.normalize('NFC'),
		);
		delete actual._catalog;
		if (JSON.stringify(actual) !== JSON.stringify(source))
			throw new Error(`Deck payload differs: ${file}`);
		deckPayloads++;
	}
	const orphans = Number(
		(
			await db.execute(
				"SELECT count(*) AS n FROM edges e LEFT JOIN nodes n ON e.dst=n.id LEFT JOIN nodes s ON e.src=s.id WHERE e.rel IN ('published_contains','published_in') AND (n.id IS NULL OR s.id IS NULL)",
			)
		).rows[0]!.n,
	);
	if (orphans) throw new Error(`${orphans} dangling published relationships`);
	let repeatImportUnchanged: boolean | null = null;
	if (process.argv.includes('--repeat')) {
		const versions = async () =>
			JSON.stringify(
				(
					await db.execute(
						'SELECT (SELECT count(*) FROM node_versions) AS nodes,(SELECT count(*) FROM edge_versions) AS edges',
					)
				).rows,
			);
		const saved = async () =>
			JSON.stringify(
				(
					await db.execute(
						"SELECT v.* FROM node_versions v JOIN nodes n ON n.id=v.id WHERE n.type='deck' ORDER BY v.id,v.ver",
					)
				).rows,
			);
		const before = await saved();
		await syncLibraryGraph(db, library, true);
		const first = await versions();
		await syncLibraryGraph(db, library, true);
		const second = await versions();
		if (first !== second)
			throw new Error(`Repeat graph import wrote new versions: ${first} -> ${second}`);
		if (before !== (await saved())) throw new Error('Graph import changed saved decks');
		repeatImportUnchanged = true;
	}
	console.log(
		JSON.stringify(
			{
				release: coverage.release,
				complete: coverage.complete,
				datasets: coverage.datasets.length,
				counts: coverage.counts,
				deckPayloadsVerified: deckPayloads,
				danglingPublishedRelationships: orphans,
				repeatImportUnchanged,
			},
			null,
			2,
		),
	);
} finally {
	library.close();
	await db.close();
}
