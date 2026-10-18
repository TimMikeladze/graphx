import { test, expect } from 'bun:test';
import { openMemoryDb } from 'graphx/local';
import { init, Graph } from 'graphx';
import { schema } from '../src/schema';
import { syncRelease } from '../src/ingest';
import { DeckStore } from '../src/decks';
const release = {
	meta: { date: '2026-10-18', version: 'test' },
	data: {
		Island: [
			{
				name: 'Island',
				type: 'Basic Land — Island',
				types: ['Land'],
				supertypes: ['Basic'],
				subtypes: ['Island'],
				colorIdentity: ['U'],
				colors: [],
				manaValue: 0,
				legalities: { modern: 'Legal' },
				printings: ['LEA'],
			},
		],
	},
};
test('import is idempotent; graph edges and temporal deck mutations persist', async () => {
	const db = await openMemoryDb();
	await init(db);
	const first = await syncRelease(db, release);
	expect(first.inserted).toBeGreaterThan(0);
	const second = await syncRelease(db, release);
	expect(second.inserted).toBe(0);
	expect(second.updated).toBe(0);
	expect(second.edgesInserted).toBe(0);
	const g = new Graph(db, schema);
	const island = first.cards[0]!;
	expect((await g.neighbors(island.id)).length).toBeGreaterThan(0);
	const store = new DeckStore(g, new Map([[island.id, island]]));
	const d = await store.create({
		name: 'Test',
		format: 'modern',
		commanderId: null,
		entries: [{ cardId: island.id, quantity: 24, board: 'main' }],
	});
	const saved = await store.save(d.id, { ...d, name: 'Changed' }, d.revision);
	expect(saved.name).toBe('Changed');
	const comparison = await store.compare(d.id, d.revision);
	expect(comparison.name).toEqual({ before: 'Test', after: 'Changed' });
	expect(saved.revision).not.toBe(d.revision);
	await expect(store.save(d.id, { ...d, name: 'stale' }, d.revision)).rejects.toThrow();
	expect((await store.get(d.id)).entries[0]?.quantity).toBe(24);
	expect((await store.history(d.id)).length).toBe(2);
	expect((await g.listEdges({ src: d.id, rel: 'contains' })).edges).toHaveLength(1);
	const imported = store.parse('4 Island\nSideboard\n2 Island\n1 This Does Not Exist');
	expect(imported.entries).toHaveLength(2);
	expect(imported.unknown).toEqual(['1 This Does Not Exist']);
	await db.close();
});
