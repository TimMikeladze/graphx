import { Graph, bulkLoad, bulkEdges, type DbClient, type BulkRow, type BulkEdgeRow } from 'graphx';
import { createHash } from 'node:crypto';
import { CatalogStore } from './library';
import { schema, type Card } from './schema';
import { key, normalizeCard } from './catalog';
import { canonical } from './ingest';
export async function syncLibraryGraph(db: DbClient, library: CatalogStore, force = false) {
	const coverage = library.coverage();
	if (!coverage.complete || !coverage.release) return;
	const graph = new Graph(db, schema);
	const fingerprint = createHash('sha256')
		.update(JSON.stringify(['schema 2', ...coverage.datasets.map((s) => [s.name, s.sha256])]))
		.digest('hex');
	const marker = await graph.getNode('dataset:mtgjson-library');
	if (!force && marker?.data.name === fingerprint) return;
	const existing = new Map(
		(await db.execute('SELECT id,type,data FROM nodes')).rows.map((r) => [
			String(r.id),
			{ type: String(r.type), data: JSON.parse(String(r.data)) },
		]),
	);
	const cards = new Map<string, Card>(
		[...existing].filter(([, v]) => v.type === 'card').map(([id, v]) => [id, v.data as Card]),
	);
	const atomicIds = new Set<string>();
	for (const { id, value } of library.records('atomic'))
		atomicIds.add(normalizeCard(id, value as unknown as Record<string, any>[]).id);
	const byName = new Map(
		[...cards.values()].flatMap((c) =>
			[c.name, ...c.aliases, ...c.faces.map((f) => f.name)].map(
				(n) => [n.toLowerCase(), c] as const,
			),
		),
	);
	const nodes: BulkRow<typeof schema>[] = [];
	const edges = new Map<string, BulkEdgeRow<typeof schema>>();
	const setIds = new Set<string>();
	const deckIds = new Set<string>();
	for (const { id, value } of library.records('sets')) {
		const nodeId = key('set', id);
		setIds.add(nodeId);
		const {
			cards: _cards,
			tokens: _tokens,
			sealedProduct: _sealed,
			booster: _booster,
			...metadata
		} = value;
		const data = { ...metadata, name: value.name, sourceId: id };
		if (existing.has(nodeId)) {
			if (canonical(existing.get(nodeId)!.data) !== canonical(data))
				await graph.updateNode(nodeId, { data });
		} else nodes.push({ id: nodeId, type: 'set', data });
	}
	const edge = (
		src: string,
		rel: 'published_in' | 'published_contains',
		dst: string,
		data?: { quantity: number; board: string },
	) => {
		const id = `${src}|${rel}|${dst}|${data?.board ?? ''}`;
		const old = edges.get(id);
		if (old && data) {
			(old.data as { quantity: number }).quantity += data.quantity;
			return;
		}
		edges.set(id, { id, rel, src, dst, ...(data ? { data } : {}), source: 'mtgjson' });
	};
	let supplemented = 0;
	for (const { id, value } of library.records('decks')) {
		const nodeId = `published_deck:${id}`;
		deckIds.add(nodeId);
		const data = {
			name: value.name,
			sourceId: id,
			code: value.code,
			type: value.type,
			releaseDate: value.releaseDate ?? null,
		};
		if (existing.has(nodeId)) {
			if (canonical(existing.get(nodeId)!.data) !== canonical(data))
				await graph.updateNode(nodeId, { data });
		} else nodes.push({ id: nodeId, type: 'published_deck', data });
		const setId = key('set', String(value.code));
		if (setIds.has(setId)) edge(nodeId, 'published_in', setId);
		for (const board of [
			'mainBoard',
			'sideBoard',
			'commander',
			'displayCommander',
			'planes',
			'schemes',
			'planarDeck',
			'schemeDeck',
		])
			for (const c of value[board] ?? []) {
				if (!c.name) throw new Error(`Unnamed card in ${id}/${board}`);
				let card =
					(c.identifiers?.scryfallOracleId
						? cards.get(`card:${c.identifiers.scryfallOracleId}`)
						: undefined) ?? byName.get(String(c.name).toLowerCase());
				if (!card || !atomicIds.has(card.id)) {
					let source = c;
					if (c.uuid) {
						try {
							source = { ...library.get('identifiers', c.uuid), ...c };
						} catch {}
					}
					const normalized = normalizeCard(String(c.name), [
						{ ...source, printings: source.printings ?? [source.setCode ?? value.code] },
					]);
					if (card) {
						normalized.id = card.id;
						normalized.printings = [...new Set([...card.printings, ...normalized.printings])];
					}
					card = normalized;
					if (!cards.has(card.id)) {
						nodes.push({
							id: card.id,
							type: 'card',
							data: card,
							body: `${card.name}\n${card.type}\n${card.text}`,
						});
						supplemented++;
					} else if (existing.has(card.id)) {
						if (canonical(existing.get(card.id)!.data) !== canonical(card))
							await graph.updateNode(card.id, {
								data: card,
								body: `${card.name}\n${card.type}\n${card.text}`,
							});
					} else {
						const pending = nodes.find((n) => n.id === card!.id);
						if (pending) pending.data = card;
					}
					cards.set(card.id, card);
					byName.set(card.name.toLowerCase(), card);
				}
				edge(nodeId, 'published_contains', card.id, { quantity: Number(c.count ?? 1), board });
			}
	}
	for (const card of cards.values())
		if (!atomicIds.has(card.id))
			for (const code of card.printings) {
				const dst = key('set', code);
				if (setIds.has(dst)) {
					const id = `${card.id}|printed_in|${dst}`;
					edges.set(id, { id, rel: 'printed_in', src: card.id, dst, source: 'mtgjson-library' });
				}
			}
	if (nodes.length) await bulkLoad(db, schema, nodes, { chunkSize: 300, mode: 'correct' });
	const oldEdges = new Map(
		(
			await db.execute(
				"SELECT id,data FROM edges WHERE rel IN ('published_contains','published_in') OR source='mtgjson-library'",
			)
		).rows.map((r) => [String(r.id), JSON.parse(String(r.data ?? '{}'))]),
	);
	const fresh = [...edges.values()].filter((e) => !oldEdges.has(e.id!));
	const types = new Map<string, keyof typeof schema.nodes>([
		...[...existing].map(([id, v]) => [id, v.type as keyof typeof schema.nodes] as const),
		...nodes.map((n) => [n.id!, n.type] as const),
	]);
	if (fresh.length) await bulkEdges(db, schema, fresh, { chunkSize: 500, types, mode: 'correct' });
	for (const e of edges.values())
		if (oldEdges.has(e.id!) && canonical(oldEdges.get(e.id!)) !== canonical(e.data ?? {}))
			await graph.correctEdge(e.id!, { data: e.data ?? {} }, { validFrom: Date.now() });
	for (const id of oldEdges.keys()) if (!edges.has(id)) await graph.deleteEdge(id);
	for (const [id, n] of existing)
		if (n.type === 'published_deck' && !deckIds.has(id)) await graph.deleteNode(id);
	const data = {
		name: fingerprint,
		date: coverage.release.date,
		version: coverage.release.version,
		coverage: 'complete',
		cards: cards.size,
		source: 'https://mtgjson.com/downloads/all-files/',
	};
	if (marker) {
		if (canonical(marker.data) !== canonical(data))
			await graph.updateNode('dataset:mtgjson-library', { data });
	} else
		await bulkLoad(db, schema, [{ id: 'dataset:mtgjson-library', type: 'dataset', data }], {
			mode: 'correct',
		});
	console.log(
		`[catalog] Graph: ${setIds.size} sets, ${deckIds.size} published decks, ${edges.size} relationships, ${supplemented} supplemental cards`,
	);
}
