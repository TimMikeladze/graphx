import { Graph, history } from 'graphx';
import { deckSchema, schema, type Card, type Deck, type DeckRecord, type Entry } from './schema';
import { InputError } from './search';
export class NotFound extends Error {
	status = 404;
}
export class Conflict extends Error {
	status = 409;
}
export class DeckStore {
	constructor(
		readonly graph: Graph<typeof schema>,
		readonly catalog: Map<string, Card>,
	) {}
	async list() {
		const rows = (
			await this.graph.listNodes({ type: 'deck', limit: 100, limits: { maxRows: 100 } })
		).nodes;
		return Promise.all(rows.map((n) => this.get(n.id)));
	}
	async get(id: string): Promise<DeckRecord> {
		const n = await this.graph.getNodeVersion(id);
		if (!n || n.type !== 'deck') throw new NotFound('Deck not found');
		return { ...(n.data as Deck), id: n.id, revision: n.revision };
	}
	check(input: unknown) {
		const d = deckSchema.parse(input);
		for (const e of d.entries)
			if (!this.catalog.has(e.cardId)) throw new InputError(`Unknown card: ${e.cardId}`);
		if (d.commanderId && !this.catalog.has(d.commanderId))
			throw new InputError('Unknown commander');
		return d;
	}
	async create(input: unknown) {
		const d = this.check(input);
		let id = '';
		await this.graph.atomic(async (scope) => {
			const n = await scope.addNode({ type: 'deck', data: d });
			id = n.id;
			for (const e of d.entries)
				await scope.addEdge({
					rel: 'contains',
					src: id,
					dst: e.cardId,
					data: { quantity: e.quantity, board: e.board },
				});
		});
		return this.get(id);
	}
	async save(id: string, input: unknown, revision: string) {
		const d = this.check(input);
		if (typeof revision !== 'string' || !revision) throw new InputError('A revision is required');
		await this.graph.atomic(async (scope) => {
			const old = await scope.getNodeVersion(id);
			if (!old || old.type !== 'deck') throw new NotFound('Deck not found');
			if (old.revision !== revision)
				throw new Conflict('Deck changed in another tab. Reload before saving.');
			await scope.updateNode(id, { data: d }, { expectedRevision: revision });
			const edges = await scope.listEdges({ rel: 'contains', src: id });
			for (const e of edges) await scope.deleteEdge(e.id);
			for (const e of d.entries)
				await scope.addEdge({
					rel: 'contains',
					src: id,
					dst: e.cardId,
					data: { quantity: e.quantity, board: e.board },
				});
		});
		return this.get(id);
	}
	async history(id: string) {
		await this.get(id);
		return (await history(this.graph.raw, id))
			.filter((r) => r.current)
			.map((r) => ({
				revision: String(r.ver),
				at: Number(r.valid_from),
				data: JSON.parse(String(r.data)) as Deck,
			}));
	}
	async compare(id: string, revision: string) {
		const current = await this.get(id);
		const version = (await history(this.graph.raw, id)).find((v) => String(v.ver) === revision);
		if (!version) throw new NotFound('Revision not found');
		const previous = deckSchema.parse(JSON.parse(String(version.data)));
		const before = new Map(previous.entries.map((e) => [`${e.board}:${e.cardId}`, e]));
		const after = new Map(current.entries.map((e) => [`${e.board}:${e.cardId}`, e]));
		const added: Record<string, unknown>[] = [],
			removed: Record<string, unknown>[] = [];
		for (const key of new Set([...before.keys(), ...after.keys()])) {
			const a = before.get(key),
				b = after.get(key);
			const change = (b?.quantity ?? 0) - (a?.quantity ?? 0);
			const entry = b ?? a!;
			if (change)
				(change > 0 ? added : removed).push({
					cardId: entry.cardId,
					name: this.catalog.get(entry.cardId)?.name ?? entry.cardId,
					board: entry.board,
					quantity: Math.abs(change),
				});
		}
		return {
			from: revision,
			to: current.revision,
			name: { before: previous.name, after: current.name },
			format: { before: previous.format, after: current.format },
			added,
			removed,
		};
	}

	parse(text: string) {
		if (text.length > 100000) throw new InputError('Decklist exceeds 100 KB');
		const byName = new Map(
			[...this.catalog.values()].flatMap((c) => [
				[c.name.toLowerCase(), c] as const,
				...c.faces.map((f) => [f.name.toLowerCase(), c] as const),
				...c.aliases.map((alias) => [alias.toLowerCase(), c] as const),
			]),
		);
		const entries: Entry[] = [];
		const unknown: string[] = [];
		let board: Entry['board'] = 'main';
		let commanderId: string | null = null;
		let commander = false;
		for (const line of text.split(/\r?\n/)) {
			const l = line.trim();
			if (!l || l.startsWith('//') || l.startsWith('#')) continue;
			if (/^sideboard:?$/i.test(l)) {
				board = 'side';
				commander = false;
				continue;
			}
			if (/^(maybeboard|considering):?$/i.test(l)) {
				board = 'maybe';
				commander = false;
				continue;
			}
			if (/^(mainboard|deck):?$/i.test(l)) {
				board = 'main';
				commander = false;
				continue;
			}
			if (/^commander:?$/i.test(l)) {
				commander = true;
				continue;
			}
			const m = l.match(/^(\d+)x?\s+(.+?)(?:\s+\([A-Za-z0-9]+\)\s*\S*)?(?:\s+\*F\*)?$/);
			if (!m) {
				unknown.push(l);
				continue;
			}
			const qty = Number(m[1]);
			const c = byName.get(m[2]!.toLowerCase());
			if (!c || qty < 1 || qty > 999) {
				unknown.push(l);
				continue;
			}
			if (commander) {
				if (qty !== 1 || commanderId) unknown.push(l);
				else commanderId = c.id;
				continue;
			}
			const old = entries.find((e) => e.cardId === c.id && e.board === board);
			if (old) old.quantity += qty;
			else entries.push({ cardId: c.id, quantity: qty, board });
		}
		return { entries, commanderId, unknown };
	}
	export(d: Deck) {
		const sections: string[] = [];
		if (d.commanderId)
			sections.push(`Commander\n1 ${this.catalog.get(d.commanderId)?.name ?? d.commanderId}`);
		for (const [board, label] of [
			['main', 'Deck'],
			['side', 'Sideboard'],
			['maybe', 'Maybeboard'],
		] as const) {
			const es = d.entries.filter((e) => e.board === board);
			if (es.length)
				sections.push(
					`${label}\n${es.map((e) => `${e.quantity} ${this.catalog.get(e.cardId)?.name ?? e.cardId}`).join('\n')}`,
				);
		}
		return sections.join('\n\n');
	}
}
