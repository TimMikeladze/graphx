import Database from 'libsql';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamObject } from 'stream-json/streamers/stream-object.js';
import chain from 'stream-chain';
import { InputError } from './search';
import { NotFound, type DeckStore } from './decks';
import { formats, type Card, type Entry } from './schema';
export const libraryKinds = [
	'sets',
	'decks',
	'printings',
	'tokens',
	'sealed',
	'identifiers',
	'prices',
	'pricesToday',
	'skus',
	'atomic',
	'cardmarket',
	'reference',
] as const;
export type LibraryKind = (typeof libraryKinds)[number];
export const sourceNames = [
	'AtomicCards',
	'AllPrintings',
	'AllDeckFiles',
	'AllIdentifiers',
	'AllPrices',
	'AllPricesToday',
	'TcgplayerSkus',
	'CardmarketIdentifiers',
	'SetList',
	'DeckList',
	'CardTypes',
	'Keywords',
	'EnumValues',
	'CompiledList',
	'Meta',
] as const;
type Raw = Record<string, any>;
interface Source {
	name: string;
	file: string;
	sha256: string;
	date: string;
	version: string;
	bytes: number;
	source: string;
}
interface Manifest {
	release: { date: string; version: string };
	datasets: Source[];
}
export interface Coverage {
	complete: boolean;
	release: { date: string; version: string } | null;
	datasets: Raw[];
	counts: Record<string, number>;
	issues: string[];
}
const kindCheck = (kind: string): LibraryKind => {
	if (!libraryKinds.includes(kind as LibraryKind)) throw new InputError('Unknown library kind');
	return kind as LibraryKind;
};
function rawValue(row: unknown): Raw {
	return row as Raw;
}
export class CatalogStore {
	private db: InstanceType<typeof Database> | null = null;
	private stamp = '';
	constructor(readonly path: string) {}
	private connection() {
		if (!existsSync(this.path)) return null;
		const stat = statSync(this.path);
		const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
		if (!this.db || stamp !== this.stamp) {
			this.db?.close();
			this.db = new Database(this.path, { readonly: true });
			this.stamp = stamp;
		}
		return this.db;
	}
	close() {
		this.db?.close();
		this.db = null;
	}
	coverage(): Coverage {
		const db = this.connection();
		if (!db)
			return {
				complete: false,
				release: null,
				datasets: sourceNames.map((name) => ({
					name,
					expected: 0,
					imported: 0,
					complete: false,
					date: null,
					sha256: null,
				})),
				counts: {},
				issues: ['Complete MTGJSON catalog has not been imported.'],
			};
		const saved = JSON.parse(
			String(rawValue(db.prepare("SELECT value FROM metadata WHERE key='coverage'").get()).value),
		) as Coverage;
		const counts = Object.fromEntries(
			db
				.prepare('SELECT kind,count(*) AS n FROM records GROUP BY kind')
				.all()
				.map((row) => {
					const r = rawValue(row);
					return [r.kind, Number(r.n)];
				}),
		);
		const datasets = saved.datasets.map((d) => {
			const imported = Number(
				rawValue(db.prepare('SELECT count(*) AS n FROM records WHERE source=?').get(d.name)).n,
			);
			return { ...d, imported, complete: imported === d.expected };
		});
		return {
			...saved,
			counts,
			datasets,
			complete: saved.complete && datasets.every((d) => d.complete),
		};
	}
	list(
		kind: string,
		options: {
			q?: string;
			set?: string;
			type?: string;
			page?: number;
			limit?: number;
			oracleId?: string;
		} = {},
	) {
		kindCheck(kind);
		const page = options.page ?? 1,
			limit = options.limit ?? 36;
		if (
			!Number.isInteger(page) ||
			page < 1 ||
			!Number.isSafeInteger((page - 1) * limit) ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100
		)
			throw new InputError('Page must be positive and limit must be 1–100');
		const db = this.connection();
		if (!db) return { items: [], total: 0, page, limit, pages: 0 };
		const conditions = ['kind=?'];
		const args: any[] = [kind];
		if (options.q) {
			conditions.push("(name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
			const q = `%${options.q.replace(/[\\%_]/g, '\\$&')}%`;
			args.push(q, q);
		}
		if (options.set) {
			conditions.push('set_code=?');
			args.push(options.set.toUpperCase());
		}
		if (options.type) {
			conditions.push('category=?');
			args.push(options.type);
		}
		if (options.oracleId) {
			conditions.push('oracle_id=?');
			args.push(options.oracleId.replace(/^card:/, ''));
		}
		const where = conditions.join(' AND ');
		const total = Number(
			rawValue(db.prepare(`SELECT count(*) AS n FROM records WHERE ${where}`).get(...args)).n,
		);
		const items = db
			.prepare(
				`SELECT id,name,set_code AS setCode,category AS type,release_date AS releaseDate,card_count AS cardCount FROM records WHERE ${where} ORDER BY name COLLATE NOCASE,id LIMIT ? OFFSET ?`,
			)
			.all(...args, limit, (page - 1) * limit);
		return { items, total, page, limit, pages: Math.ceil(total / limit) };
	}
	summary(kind: string, id: string): Raw | null {
		kindCheck(kind);
		const row = this.connection()
			?.prepare(
				'SELECT id,name,set_code AS setCode,category AS type,release_date AS releaseDate,card_count AS cardCount FROM records WHERE kind=? AND id=?',
			)
			.get(kind, id);
		return row ? rawValue(row) : null;
	}
	get(kind: string, id: string): Raw {
		kindCheck(kind);
		const row = this.connection()
			?.prepare('SELECT data FROM records WHERE kind=? AND id=?')
			.get(kind, id);
		if (!row) throw new NotFound('Library record not found');
		const value = JSON.parse(String(rawValue(row).data));
		return {
			...(value && typeof value === 'object' && !Array.isArray(value) ? value : { data: value }),
			_catalog: { id, kind },
		};
	}
	*records(kind: LibraryKind): Generator<{ id: string; value: Raw }> {
		const db = this.connection();
		if (!db) return;
		for (const row of db
			.prepare('SELECT id,data FROM records WHERE kind=? ORDER BY id')
			.iterate(kind)) {
			const r = rawValue(row);
			yield { id: r.id, value: JSON.parse(r.data) };
		}
	}
}
async function* streamData(path: string): AsyncGenerator<{ key: string; value: any }> {
	const stream = chain([
		createReadStream(path),
		parser(),
		pick({ filter: 'data' }),
		streamObject(),
	]);
	for await (const entry of stream) yield entry as { key: string; value: any };
}
async function readMeta(path: string) {
	const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'r'));
	try {
		const b = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(b, 0, b.length, 0);
		const text = b.toString('utf8', 0, bytesRead);
		const m = text.match(/"meta"\s*:\s*(\{[^}]*\})/);
		if (!m) throw new Error(`Missing metadata in ${basename(path)}`);
		return JSON.parse(m[1]!);
	} finally {
		await handle.close();
	}
}
async function deckFiles(path: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const file = join(path, entry.name);
		if (entry.isDirectory()) result.push(...(await deckFiles(file)));
		else if (entry.isFile() && entry.name.endsWith('.json')) result.push(file);
	}
	return result;
}
export async function buildCatalog(root: string) {
	const data = join(root, 'data');
	const manifest = JSON.parse(await readFile(join(data, 'manifest.json'), 'utf8')) as Manifest;
	for (const name of sourceNames)
		if (!manifest.datasets.some((s) => s.name === name)) throw new Error(`Missing source ${name}`);
	for (const source of manifest.datasets)
		if (source.date !== manifest.release.date || source.version !== manifest.release.version)
			throw new Error(`Mixed release: ${source.name}`);
	const output = join(root, `catalog.${process.pid}.${crypto.randomUUID()}.db.tmp`);
	const db = new Database(output);
	db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF;
 CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,set_code TEXT,category TEXT,release_date TEXT,oracle_id TEXT,card_count INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
 CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
	const insert = db.prepare(
		'INSERT INTO records(kind,id,name,set_code,category,release_date,oracle_id,card_count,source,data) VALUES(?,?,?,?,?,?,?,?,?,?)',
	);
	const expected = new Map<string, number>();
	const counts: Record<string, number> = {};
	const issues: string[] = [];
	let pending = 0;
	db.exec('BEGIN');
	const put = (kind: LibraryKind, id: string, value: any, source: string, extra: Raw = {}) => {
		const v = Array.isArray(value) ? (value[0] ?? {}) : (value ?? {});
		const main = Array.isArray(value?.mainBoard) ? value.mainBoard : [];
		const cardCount =
			kind === 'sets'
				? (value.cards?.length ?? 0) + (value.tokens?.length ?? 0)
				: kind === 'decks'
					? [...main, ...(value.commander ?? []), ...(value.sideBoard ?? [])].reduce(
							(n: number, c: Raw) => n + Number(c.count ?? 1),
							0,
						)
					: 0;
		insert.run(
			kind,
			id,
			String(v.name ?? id),
			extra.setCode ?? v.setCode ?? v.code ?? null,
			extra.type ?? v.type ?? null,
			v.releaseDate ?? null,
			v.identifiers?.scryfallOracleId ?? null,
			cardCount,
			source,
			JSON.stringify(value),
		);
		expected.set(source, (expected.get(source) ?? 0) + 1);
		counts[kind] = (counts[kind] ?? 0) + 1;
		if (++pending >= 1000) {
			db.exec('COMMIT;BEGIN');
			pending = 0;
		}
	};
	try {
		for (const name of sourceNames) {
			const source = manifest.datasets.find((s) => s.name === name)!;
			const path = join(data, source.file);
			console.log(`[catalog] Importing ${name}`);
			if (name === 'AllDeckFiles') {
				const files = await deckFiles(path);
				for (const file of files) {
					const doc = JSON.parse(await readFile(file, 'utf8'));
					if (
						doc.meta?.date !== manifest.release.date ||
						doc.meta?.version !== manifest.release.version
					)
						throw new Error(`Mixed deck release: ${basename(file)}`);
					put(
						'decks',
						basename(file)
							.replace(/\.json$/, '')
							.normalize('NFC'),
						doc.data,
						name,
					);
				}
			} else {
				const meta = await readMeta(path);
				if (meta.date !== manifest.release.date || meta.version !== manifest.release.version)
					throw new Error(`Mixed release: ${name}`);
				if (
					[
						'SetList',
						'DeckList',
						'CardTypes',
						'Keywords',
						'EnumValues',
						'CompiledList',
						'Meta',
					].includes(name)
				) {
					const doc = JSON.parse(await readFile(path, 'utf8'));
					put('reference', name, doc.data ?? doc.meta, name);
				} else
					for await (const { key, value } of streamData(path)) {
						if (name === 'CardmarketIdentifiers') {
							for (const [id, record] of Object.entries(value))
								put('cardmarket', `${key}:${id}`, record, name, {
									type: key,
									setCode: (record as Raw).setCodes?.[0],
								});
						} else if (name === 'AllPrintings') {
							if (value.code !== key) throw new Error(`Set code mismatch ${key}`);
							put('sets', key, value, name);
							for (const card of value.cards ?? []) {
								if (!card.uuid) throw new Error(`Missing printing UUID in ${key}`);
								put('printings', card.uuid, card, name, { setCode: key });
							}
							for (const token of value.tokens ?? [])
								put('tokens', token.uuid, token, name, { setCode: key });
							for (const product of value.sealedProduct ?? [])
								put('sealed', product.uuid, product, name, { setCode: key });
						} else {
							const kinds: Record<string, LibraryKind> = {
								AtomicCards: 'atomic',
								AllIdentifiers: 'identifiers',
								AllPrices: 'prices',
								AllPricesToday: 'pricesToday',
								TcgplayerSkus: 'skus',
								CardmarketIdentifiers: 'cardmarket',
							};
							put(kinds[name]!, key, value, name);
						}
					}
			}
			console.log(`[catalog] ${name}: ${expected.get(name) ?? 0} records`);
		}
		db.exec('COMMIT');
		const readReference = (id: string) =>
			JSON.parse(
				String(
					rawValue(db.prepare("SELECT data FROM records WHERE kind='reference' AND id=?").get(id))
						.data,
				),
			);
		for (const [source, kind, field] of [
			['SetList', 'sets', 'code'],
			['DeckList', 'decks', 'fileName'],
		] as const) {
			const index = readReference(source) as Raw[];
			const actual = new Set(
				db
					.prepare('SELECT id FROM records WHERE kind=?')
					.all(kind)
					.map((r) => String(rawValue(r).id)),
			);
			const indexed = new Set(
				index.map((r) =>
					String(r[field])
						.replace(/\.json$/, '')
						.normalize('NFC'),
				),
			);
			const missing = [...indexed].filter((id) => !actual.has(id));
			const extra = [...actual].filter((id) => !indexed.has(id));
			if (missing.length || extra.length)
				throw new Error(
					`${source} mismatch: missing ${missing.slice(0, 5).join(',')}; extra ${extra.slice(0, 5).join(',')}`,
				);
		}
		const orphaned = Number(
			rawValue(
				db
					.prepare(
						"SELECT count(*) AS n FROM records r WHERE r.kind IN ('printings','tokens') AND NOT EXISTS(SELECT 1 FROM records i WHERE i.kind='identifiers' AND i.id=r.id)",
					)
					.get(),
			).n,
		);
		const extraIdentifiers = Number(
			rawValue(
				db
					.prepare(
						"SELECT count(*) AS n FROM records i WHERE i.kind='identifiers' AND NOT EXISTS(SELECT 1 FROM records p WHERE p.kind='printings' AND p.id=i.id) AND NOT EXISTS(SELECT 1 FROM records t WHERE t.kind='tokens' AND t.id=i.id)",
					)
					.get(),
			).n,
		);
		if (orphaned || extraIdentifiers)
			throw new Error(
				`AllIdentifiers mismatch: ${orphaned} missing identifiers, ${extraIdentifiers} missing printings/tokens`,
			);
		db.exec(
			"UPDATE records AS r SET name=coalesce((SELECT p.name FROM records p WHERE p.kind='identifiers' AND p.id=r.id),r.name),set_code=coalesce((SELECT p.set_code FROM records p WHERE p.kind='identifiers' AND p.id=r.id),r.set_code) WHERE kind IN ('prices','pricesToday','skus')",
		);
		db.exec(
			"UPDATE records AS r SET set_code=coalesce((SELECT p.set_code FROM records p WHERE p.kind='identifiers' AND p.id=json_extract(r.data,'$.uuids[0]')),r.set_code) WHERE kind='cardmarket' AND category='products'",
		);
		db.exec(
			'CREATE INDEX records_search ON records(kind,name COLLATE NOCASE,id); CREATE INDEX records_set ON records(kind,set_code); CREATE INDEX records_oracle ON records(kind,oracle_id); CREATE INDEX records_source ON records(source);',
		);
		const datasets = manifest.datasets.map((s) => {
			const imported = Number(
				rawValue(db.prepare('SELECT count(*) AS n FROM records WHERE source=?').get(s.name)).n,
			);
			return {
				...s,
				expected: expected.get(s.name) ?? 0,
				imported,
				complete: imported === (expected.get(s.name) ?? 0),
			};
		});
		const report: Coverage = {
			complete: datasets.every((d) => d.complete),
			release: manifest.release,
			datasets,
			counts,
			issues,
		};
		db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(
			'coverage',
			JSON.stringify(report),
		);
		db.close();
		await rename(output, join(root, 'catalog.db'));
		return report;
	} catch (error) {
		try {
			db.close();
		} catch {}
		await rm(output, { force: true });
		throw error;
	}
}
export async function copyPublishedDeck(
	store: CatalogStore,
	id: string,
	format: string,
	decks: DeckStore,
	catalog: Map<string, Card>,
) {
	if (!formats.includes(format as (typeof formats)[number]))
		throw new InputError('Select a supported format');
	const raw = store.get('decks', id);
	const commanders: Raw[] = raw.commander ?? [];
	if (commanders.reduce((n, c) => n + Number(c.count ?? 1), 0) > 1)
		throw new InputError(
			'This deck has multiple commanders; the editor currently supports one. The complete source deck remains available in the library.',
		);
	if (commanders.length && format !== 'commander')
		throw new InputError('Choose Commander format to preserve this deck’s commander.');
	for (const section of ['planes', 'schemes', 'planarDeck', 'schemeDeck'])
		if (raw[section]?.length)
			throw new InputError(
				`The editor cannot represent ${section}; view the complete source deck in the library.`,
			);
	const byName = new Map(
		[...catalog.values()].flatMap((c) =>
			[c.name, ...c.aliases, ...c.faces.map((f) => f.name)].map(
				(name) => [name.toLowerCase(), c] as const,
			),
		),
	);
	const resolve = (c: Raw) => {
		const oracle = c.identifiers?.scryfallOracleId;
		const card =
			(oracle ? catalog.get(`card:${oracle}`) : undefined) ??
			byName.get(String(c.name).toLowerCase());
		if (!card) throw new InputError(`Cannot copy unresolved card: ${c.name}`);
		return card;
	};
	const entries: Entry[] = [];
	for (const [section, board] of [
		['mainBoard', 'main'],
		['sideBoard', 'side'],
	] as const)
		for (const c of raw[section] ?? []) {
			const card = resolve(c);
			const quantity = Number(c.count ?? 1);
			const old = entries.find((e) => e.cardId === card.id && e.board === board);
			if (old) old.quantity += quantity;
			else entries.push({ cardId: card.id, quantity, board });
		}
	return decks.create({
		name: raw.name,
		format,
		entries,
		commanderId: commanders.length ? resolve(commanders[0]!).id : null,
	});
}
