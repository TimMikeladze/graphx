import {
	type Constraint,
	declareSingleValuedRel,
	declareUniqueNodeProp,
	parseIndexName,
} from './constraints.ts';
import {
	type DbClient,
	type Dialect,
	dialectOf,
	type SqlRow,
	type SqlStatement,
} from './dialect.ts';
import { embReadExpr, embValueExpr, insertOrIgnore, META_UPSERT_SQL } from './dialect-sql.ts';
import { FOREVER, ftsIndexOwner, managedWriter } from './runtime.ts';
import {
	createEmbeddings,
	dropEmbeddings,
	type EmbeddingMeta,
	init,
	readEmbeddingMeta,
} from './schema.ts';

/**
 * Fork — branch one namespace into another. The target becomes an independent copy of the
 * source's graph (optionally as it stood at an instant), and from then on the two diverge:
 * a write to either is invisible to the other. This is the "what if" primitive — fork the
 * world, change one thing in the branch, run both forward, compare.
 *
 * A fork is a COPY by default: the backends graphx runs on have no shared-storage branching it
 * could lean on uniformly, and a copy keeps every read path untouched. It is written with plain
 * per-dialect SQL, so the target may be a different backend from the source (libSQL → Postgres,
 * Postgres → DuckDB, …) — a fork doubles as a backend migration. When the backend CAN branch a
 * database itself (bql.sh, two databases on one server) the fork lets it, then trims the result
 * in place to exactly what a copy would have produced — see {@link NativeFork}.
 *
 * What travels: node and edge versions (ids preserved, intervals preserved or cut at `asOf`),
 * the embedding model and its vectors, local blobs the copied versions reference, declared
 * constraints, other `graph_meta` facts, and — on a full fork — the analytics side tables.
 * What does not: the outbox, trigger cursors and dead letters (a fork starts a fresh event
 * log), and archival state. `ver` — a node version's `revision` — is re-minted by a copy and
 * kept by a native fork.
 */

/** Options for {@link fork}. */
export interface ForkOpts {
	/**
	 * Fork the graph as it stood at this instant (epoch ms). Versions that began after it are
	 * left behind; versions live at it are reopened, so they are live in the fork. History
	 * before it is copied intact, so the fork's own `asOf` reads of the past still answer.
	 * A valid-time cut keeps current beliefs only: what the source believes now about then.
	 * Omit to copy every version verbatim.
	 */
	asOf?: number;
	/**
	 * Fork the database as it was recorded at this instant (epoch ms): rows recorded after it are
	 * left behind, and beliefs current at it are current again, so the branch believes what the
	 * source believed then — corrections made later never happened in it. History recorded before
	 * it travels intact. Combines with `asOf` (D8): the world at `asOf` as believed at
	 * `recordedAsOf`.
	 */
	recordedAsOf?: number;
	/** Rows read and written per round trip (default 500). */
	pageSize?: number;
	/**
	 * `'auto'` (default) lets the backend branch the database itself when it can — bql.sh forks a
	 * database on the same server without copying a row — and copies otherwise. `'copy'` always
	 * copies, row by row.
	 */
	method?: 'auto' | 'copy';
}

/**
 * A client whose backend can branch a whole database itself. `nativeFork` either makes `target`
 * a full, independent copy of the source database and returns a handle to it, or changes nothing
 * and returns null — then {@link fork} copies. bql.sh's remote client has it (`bql.ts`).
 */
export interface NativeFork {
	nativeFork(target: DbClient): Promise<NativeBranch | null>;
}

/** A database a {@link NativeFork} created. */
export interface NativeBranch {
	/** Delete it, and leave the target client able to create its database again on first use. */
	discard(): Promise<void>;
}

function nativeForkOf(client: DbClient): NativeFork | null {
	const candidate = client as Partial<NativeFork>;
	return typeof candidate.nativeFork === 'function' ? (candidate as NativeFork) : null;
}

/** What {@link fork} copied. */
export interface ForkResult {
	/** The valid-time cut, or `null`. */
	asOf: number | null;
	/** The recorded-time cut, or `null`. Both `null` is a full fork. */
	recordedAsOf: number | null;
	/** `'native'` when the backend branched the database itself, `'copy'` when rows were copied. */
	method: 'native' | 'copy';
	nodes: number;
	nodeVersions: number;
	edges: number;
	edgeVersions: number;
	/** Vector rows (chunks) copied. */
	vectors: number;
	/** Local blobs copied. */
	blobs: number;
	/** Declared constraints re-declared on the target. */
	constraints: number;
	/**
	 * Nodes live in the fork whose vector could not be copied: on an `asOf` fork, the source's
	 * stored vector belongs to a LATER version than the one the fork keeps. Re-embed these
	 * (`Graph.embedNode`) — `Graph.fork` does so itself when it has an embedder.
	 */
	needsEmbedding: string[];
}

/** A fork that was refused before anything was written. */
export class ForkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ForkError';
	}
}

const NODE_COLS =
	'id, type, body, uri, content_hash, content_type, data, valid_from, valid_to, recorded_from, recorded_to';
const EDGE_COLS =
	'id, src, dst, rel, weight, data, source, valid_from, valid_to, recorded_from, recorded_to';
const EMB_KEYS = new Set(['emb_model', 'emb_dim']);
/** DuckDB records constraints in `graph_meta`; they are re-declared, not copied, so a fork
 *  onto another backend gets real indexes instead of inert keys. */
const DUCK_UNIQUE = 'unique_prop:';
const DUCK_SINGLE = 'single_rel:';
const BLOB_PREFIX = 'graphx:blob:';

/** Postgres returns int8 as a string and DuckDB BIGINT as a bigint; the copy wants numbers. */
function num(v: unknown): number {
	return Number(v);
}

function str(v: unknown): string | null {
	return v === null || v === undefined ? null : String(v);
}

/** `rows` value tuples of `cols` bare `?` cells, or of the given cell expressions. */
function placeholders(rows: number, cols: number | string[]): string {
	const cells = typeof cols === 'number' ? Array.from({ length: cols }, () => '?') : cols;
	const one = `(${cells.join(',')})`;
	return Array.from({ length: rows }, () => one).join(',');
}

async function tableExists(client: DbClient, table: string): Promise<boolean> {
	const d = dialectOf(client);
	const sql =
		d === 'libsql' || d === 'sqlite'
			? "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
			: 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?';
	return (await client.execute({ sql, args: [table] })).rows.length > 0;
}

async function isEmpty(client: DbClient): Promise<boolean> {
	for (const t of ['node_identity', 'edge_identity']) {
		if ((await client.execute(`SELECT id FROM ${t} LIMIT 1`)).rows.length > 0) return false;
	}
	return true;
}

async function readConstraints(client: DbClient, meta: SqlRow[]): Promise<Constraint[]> {
	const d: Dialect = dialectOf(client);
	if (d === 'duckdb') {
		const out: Constraint[] = [];
		for (const row of meta) {
			const key = String(row.key);
			if (key.startsWith(DUCK_SINGLE))
				out.push({ kind: 'single', rel: key.slice(DUCK_SINGLE.length) });
			if (key.startsWith(DUCK_UNIQUE)) {
				const rest = key.slice(DUCK_UNIQUE.length);
				const at = rest.lastIndexOf(':');
				out.push({ kind: 'unique', type: rest.slice(0, at), prop: rest.slice(at + 1) });
			}
		}
		return out;
	}
	const sql =
		d === 'postgres'
			? "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'ux!_%' ESCAPE '!'"
			: "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ux!_%' ESCAPE '!'";
	const rows = (await client.execute(sql)).rows;
	return rows.map((r) => parseIndexName(String(r.name))).filter((c): c is Constraint => c !== null);
}

/**
 * Branch `source`'s graph into `target`. Returns what the branch holds and how it was made.
 *
 * With `method: 'auto'` the source's backend branches the database itself when it can
 * ({@link NativeFork}: bql.sh, two databases on one server, a target not created yet), and the
 * result is trimmed in place to exactly what a copy would produce; a trim that fails discards the
 * branch. Otherwise rows are copied into `target`, which must be a different, empty namespace
 * (initialised here if it is not already).
 *
 * With `asOf` or `recordedAsOf`, the cut is consistent even while the source keeps taking
 * writes: anything written later either starts after the cut (left behind) or closes a version
 * after it (which the fork reopens anyway). A full fork of a namespace under concurrent writes can observe a
 * write half-copied; pass `asOf: Date.now()` for a clean cut of a live namespace.
 */
export async function fork(
	source: DbClient,
	target: DbClient,
	opts: ForkOpts = {},
): Promise<ForkResult> {
	if (source === target) throw new ForkError('fork: source and target are the same client');
	const instant = (t: number | undefined, name: string): number | null => {
		if (t === undefined) return null;
		if (!Number.isInteger(t)) throw new ForkError(`fork: ${name} must be an integer epoch ms`);
		return t;
	};
	const cut: Cut = {
		asOf: instant(opts.asOf, 'asOf'),
		recordedAsOf: instant(opts.recordedAsOf, 'recordedAsOf'),
	};
	const pageSize = Math.max(1, opts.pageSize ?? 500);
	const sd = dialectOf(source);
	const td = dialectOf(target);

	// Before `init(target)`: a native fork creates the target database, so it must not exist yet.
	const native = opts.method === 'copy' ? null : nativeForkOf(source);
	const branch = native ? await native.nativeFork(target) : null;
	if (branch) {
		try {
			return await trimNative(target, cut);
		} catch (error) {
			// An untrimmed branch holds the source's whole present, not the cut — never leave it.
			try {
				await branch.discard();
			} catch (discardError) {
				throw new AggregateError([error, discardError], 'fork: trim and discard both failed');
			}
			throw error;
		}
	}

	await init(target);
	if (!(await isEmpty(target))) {
		throw new ForkError('fork: the target namespace already holds a graph; fork into an empty one');
	}
	const emb = await readEmbeddingMeta(source);
	const targetEmb = await readEmbeddingMeta(target);
	if (emb && targetEmb && (targetEmb.model !== emb.model || targetEmb.dim !== emb.dim)) {
		throw new ForkError(
			`fork: the target is set up for '${targetEmb.model}' (${targetEmb.dim} dims) but the source is embedded with '${emb.model}' (${emb.dim} dims)`,
		);
	}
	const sourceBlobs =
		(sd === 'libsql' || sd === 'sqlite') && (await tableExists(source, 'graphx_blobs'));
	if (sourceBlobs && td !== 'libsql' && td !== 'sqlite') {
		const any = await source.execute('SELECT hash FROM graphx_blobs LIMIT 1');
		if (any.rows.length > 0) {
			throw new ForkError(`fork: the source stores local blobs, which a ${td} target cannot hold`);
		}
	}
	const meta = (await source.execute('SELECT key, value FROM graph_meta')).rows;
	const constraints = await readConstraints(source, meta);

	const undo: CopyUndo = {
		metaKeys: [],
		blobHashes: [],
		vectors: targetEmb !== null,
		dropEmbeddings: false,
	};
	try {
		return await copyRows(source, target, {
			cut,
			pageSize,
			emb,
			sourceBlobs,
			meta,
			constraints,
			undo,
		});
	} catch (error) {
		// The target was an empty namespace; put it back, so the fork can simply be retried.
		try {
			await undoCopy(target, undo);
		} catch (undoError) {
			throw new AggregateError([error, undoError], 'fork: copy and its cleanup both failed');
		}
		throw error;
	}
}

/** What a failed copy has to take back out of the target. */
interface CopyUndo {
	/** `graph_meta` keys the copy wrote. */
	metaKeys: string[];
	/** Local blobs the copy wrote. */
	blobHashes: string[];
	/** The namespace has a vector table (the source's model). */
	vectors: boolean;
	/** The copy created that table and its model record — the target had none. */
	dropEmbeddings: boolean;
}

/** Return a target a copy failed on to the empty namespace it was. Constraint indexes stay: on an
 *  empty graph they hold nothing, and a retry declares the same ones. */
async function undoCopy(target: DbClient, undo: CopyUndo): Promise<void> {
	const d = dialectOf(target);
	const tables = [
		'node_scores',
		'node_analytics',
		...(undo.vectors ? ['node_embeddings'] : []),
		'edge_versions',
		'edge_identity',
		'node_versions',
		'node_identity',
	];
	const stmts: SqlStatement[] = [
		...tables.map((t) => ({ sql: `DELETE FROM ${t}`, args: [] })),
		...undo.metaKeys.map((key) => ({ sql: 'DELETE FROM graph_meta WHERE key = ?', args: [key] })),
		...undo.blobHashes.map((hash) => ({
			sql: 'DELETE FROM graphx_blobs WHERE hash = ?',
			args: [hash],
		})),
	];
	if (d === 'libsql' || d === 'sqlite') {
		stmts.push({ sql: "INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')", args: [] });
	}
	await target.batch(stmts, 'write');
	if (undo.dropEmbeddings) await dropEmbeddings(target);
	ftsIndexOwner(target)?.markFtsStale();
}

/** A fork's two cuts (D8); both `null` is a full fork. */
interface Cut {
	asOf: number | null;
	recordedAsOf: number | null;
}

const isFull = (c: Cut) => c.asOf === null && c.recordedAsOf === null;

/**
 * The cut as SQL over a version table (the instants are checked integers, so they are inlined).
 * `keep`: rows the branch holds — recorded by `recordedAsOf`, and with `asOf` only the beliefs
 * current then that began by `asOf`. `branchLive`: rows that are live in the branch once each
 * cut reopens what was open at it.
 */
function cutSql(c: Cut): { keep: string; branchLive: string } {
	const keep: string[] = [];
	if (c.recordedAsOf !== null) keep.push(`recorded_from <= ${c.recordedAsOf}`);
	if (c.asOf !== null) {
		keep.push(
			c.recordedAsOf === null ? `recorded_to = ${FOREVER}` : `recorded_to > ${c.recordedAsOf}`,
			`valid_from <= ${c.asOf}`,
		);
	}
	const branchLive = [
		c.asOf === null ? `valid_to = ${FOREVER}` : `valid_to > ${c.asOf}`,
		c.recordedAsOf === null ? `recorded_to = ${FOREVER}` : `recorded_to > ${c.recordedAsOf}`,
	].join(' AND ');
	return { keep: keep.length === 0 ? '1 = 1' : keep.join(' AND '), branchLive };
}

/** A row's interval end in the branch: open again if it was open at the cut. */
function reopened(to: number, at: number | null): number {
	return at !== null && to > at ? FOREVER : to;
}

interface CopyPlan {
	cut: Cut;
	pageSize: number;
	emb: EmbeddingMeta | null;
	sourceBlobs: boolean;
	meta: SqlRow[];
	constraints: Constraint[];
	undo: CopyUndo;
}

/** The row copy itself, into a target {@link fork} has checked is empty. */
async function copyRows(source: DbClient, target: DbClient, plan: CopyPlan): Promise<ForkResult> {
	const { cut, pageSize, emb, sourceBlobs, meta, constraints, undo } = plan;
	const sd = dialectOf(source);
	const td = dialectOf(target);

	// Facts first: the embedding model creates the vector table the copy below fills.
	if (emb) {
		const had = undo.vectors;
		await createEmbeddings(target, emb);
		undo.vectors = true;
		undo.dropEmbeddings = !had;
	}
	for (const row of meta) {
		const key = String(row.key);
		if (EMB_KEYS.has(key) || key.startsWith(DUCK_UNIQUE) || key.startsWith(DUCK_SINGLE)) continue;
		await target.execute({ sql: META_UPSERT_SQL, args: [key, String(row.value)] });
		undo.metaKeys.push(key);
	}

	const { keep } = cutSql(cut);
	const cutWhere = isFull(cut) ? '' : ` AND ${keep}`;
	const validTo = (v: unknown): number => reopened(num(v), cut.asOf);
	const recordedTo = (v: unknown): number => reopened(num(v), cut.recordedAsOf);
	/** Live in the branch but not in the source: its stored vector belongs to another row. */
	const newlyLive = (r: SqlRow): boolean =>
		validTo(r.valid_to) === FOREVER &&
		recordedTo(r.recorded_to) === FOREVER &&
		!(num(r.valid_to) === FOREVER && num(r.recorded_to) === FOREVER);

	// Node versions, in `ver` order so each id's versions keep their order in the target.
	const needsEmbedding: string[] = [];
	const blobHashes = new Set<string>();
	let nodeVersions = 0;
	for (let after = -1; ; ) {
		const rows = (
			await source.execute({
				sql: `SELECT ver, ${NODE_COLS} FROM node_versions WHERE ver > ?${cutWhere} ORDER BY ver LIMIT ?`,
				args: [after, pageSize],
			})
		).rows;
		if (rows.length === 0) break;
		after = num(rows[rows.length - 1]!.ver);
		const ids = [...new Set(rows.map((r) => String(r.id)))];
		const args = rows.flatMap((r) => {
			const uri = str(r.uri);
			if (uri?.startsWith(BLOB_PREFIX)) blobHashes.add(uri.slice(BLOB_PREFIX.length));
			if (emb && newlyLive(r)) needsEmbedding.push(String(r.id));
			return [
				String(r.id),
				String(r.type),
				str(r.body),
				uri,
				str(r.content_hash),
				str(r.content_type),
				String(r.data),
				num(r.valid_from),
				validTo(r.valid_to),
				num(r.recorded_from),
				recordedTo(r.recorded_to),
			];
		});
		await target.batch(
			[
				{ sql: insertOrIgnore(td, 'node_identity', 'id', placeholders(ids.length, 1)), args: ids },
				{
					sql: `INSERT INTO node_versions (${NODE_COLS}) VALUES ${placeholders(rows.length, 11)}`,
					args,
				},
			],
			'write',
		);
		nodeVersions += rows.length;
	}

	// Edge versions. Endpoint identities are ensured too, so an edge whose endpoint has no
	// version at the cut (only possible through an import) still satisfies the foreign key.
	let edgeVersions = 0;
	for (let after = -1; ; ) {
		const rows = (
			await source.execute({
				sql: `SELECT ver, ${EDGE_COLS} FROM edge_versions WHERE ver > ?${cutWhere} ORDER BY ver LIMIT ?`,
				args: [after, pageSize],
			})
		).rows;
		if (rows.length === 0) break;
		after = num(rows[rows.length - 1]!.ver);
		const ids = [...new Set(rows.map((r) => String(r.id)))];
		const ends = [...new Set(rows.flatMap((r) => [String(r.src), String(r.dst)]))];
		const args = rows.flatMap((r) => [
			String(r.id),
			String(r.src),
			String(r.dst),
			String(r.rel),
			num(r.weight),
			String(r.data),
			str(r.source),
			num(r.valid_from),
			validTo(r.valid_to),
			num(r.recorded_from),
			recordedTo(r.recorded_to),
		]);
		await target.batch(
			[
				{
					sql: insertOrIgnore(td, 'node_identity', 'id', placeholders(ends.length, 1)),
					args: ends,
				},
				{ sql: insertOrIgnore(td, 'edge_identity', 'id', placeholders(ids.length, 1)), args: ids },
				{
					sql: `INSERT INTO edge_versions (${EDGE_COLS}) VALUES ${placeholders(rows.length, 11)}`,
					args,
				},
			],
			'write',
		);
		edgeVersions += rows.length;
	}

	// Vectors. The side table holds vectors for live versions only, so on a cut fork only the
	// nodes whose source live version survives the cut (and so is live in the branch too) carry
	// a vector that is true for it.
	let vectors = 0;
	if (emb) {
		const stillLive = isFull(cut)
			? ''
			: ` AND id IN (SELECT id FROM node_versions WHERE valid_to = ${FOREVER} AND recorded_to = ${FOREVER} AND ${keep})`;
		const value = embValueExpr(td);
		for (let id = '', chunk = -1; ; ) {
			const rows = (
				await source.execute({
					sql: `SELECT id, chunk, text, ${embReadExpr(sd)} AS emb, embed_hash FROM node_embeddings
					      WHERE (id > ? OR (id = ? AND chunk > ?))${stillLive} ORDER BY id, chunk LIMIT ?`,
					args: [id, id, chunk, pageSize],
				})
			).rows;
			if (rows.length === 0) break;
			const last = rows[rows.length - 1]!;
			id = String(last.id);
			chunk = num(last.chunk);
			await target.execute({
				sql: `INSERT INTO node_embeddings (id, chunk, text, emb, embed_hash) VALUES ${placeholders(rows.length, ['?', '?', '?', value, '?'])}`,
				args: rows.flatMap((r) => [
					String(r.id),
					num(r.chunk),
					str(r.text),
					typeof r.emb === 'string' ? r.emb : JSON.stringify(r.emb),
					String(r.embed_hash),
				]),
			});
			vectors += rows.length;
		}
	}

	// Blobs the copied versions reference — never unreferenced ones, which GC would reap anyway.
	let blobs = 0;
	if (sourceBlobs && blobHashes.size > 0) {
		await target.execute(
			'CREATE TABLE IF NOT EXISTS graphx_blobs (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)',
		);
		for (const hash of blobHashes) {
			const row = (
				await source.execute({ sql: 'SELECT bytes FROM graphx_blobs WHERE hash = ?', args: [hash] })
			).rows[0];
			if (!row) continue;
			await target.execute({
				sql: insertOrIgnore(td, 'graphx_blobs', 'hash, bytes', '(?, ?)'),
				args: [hash, row.bytes as Uint8Array],
			});
			undo.blobHashes.push(hash);
			blobs++;
		}
	}

	// Analytics describe the graph as it is NOW, so only a full fork carries them.
	const tables = new Set(['node_identity', 'node_versions', 'edge_identity', 'edge_versions']);
	if (isFull(cut)) {
		await copyAll(
			source,
			target,
			'node_analytics',
			'id, pagerank, community, degree, computed_at',
			'id',
			pageSize,
		);
		await copyAll(
			source,
			target,
			'node_scores',
			'id, metric, score, computed_at',
			'id, metric',
			pageSize,
		);
		tables.add('node_analytics').add('node_scores');
	}
	if (vectors > 0) tables.add('node_embeddings');

	// Constraints last, so each index is built once over the loaded rows.
	for (const c of constraints) {
		if (c.kind === 'single') await declareSingleValuedRel(target, c.rel);
		else await declareUniqueNodeProp(target, { type: c.type, prop: c.prop });
	}

	ftsIndexOwner(target)?.markFtsStale();
	const writer = managedWriter(target);
	if (writer?.durable) await writer.commit(tables);

	const count = async (t: string) =>
		num((await target.execute(`SELECT count(*) AS n FROM ${t}`)).rows[0]?.n ?? 0);
	return {
		asOf: cut.asOf,
		recordedAsOf: cut.recordedAsOf,
		method: 'copy',
		nodes: await count('node_identity'),
		nodeVersions,
		edges: await count('edge_identity'),
		edgeVersions,
		vectors,
		blobs,
		constraints: constraints.length,
		needsEmbedding: needsEmbedding.sort(),
	};
}

/**
 * After a native fork `target` is the whole source database. Make it the branch `copy` would have
 * built: the event log does not travel, and with a cut, nothing that began after it survives while
 * whatever was open at it is live again, and only the blobs the kept versions reference remain.
 * One write batch, so a failure changes nothing and {@link fork} discards the branch. SQLite
 * dialects only — the only native fork is bql.sh's.
 */
async function trimNative(target: DbClient, cut: Cut): Promise<ForkResult> {
	const d = dialectOf(target);
	if (d !== 'libsql' && d !== 'sqlite') {
		throw new ForkError(`fork: a native fork onto a ${d} target is not supported`);
	}
	const emb = await readEmbeddingMeta(target);
	const stmts: SqlStatement[] = [
		'DELETE FROM graph_outbox',
		'DELETE FROM trigger_cursors',
		'DELETE FROM trigger_dead_letters',
		'DELETE FROM archival_state',
	].map((sql) => ({ sql, args: [] }));
	let needsEmbedding: string[] = [];
	if (!isFull(cut)) {
		const { keep, branchLive } = cutSql(cut);
		const sourceLive = `valid_to = ${FOREVER} AND recorded_to = ${FOREVER}`;
		if (emb) {
			// Read before the trim: rows the cut makes live again, whose node's stored vector
			// belongs to the source's live row.
			needsEmbedding = (
				await target.execute(
					`SELECT DISTINCT id FROM node_versions WHERE ${keep} AND ${branchLive} AND NOT (${sourceLive}) ORDER BY id`,
				)
			).rows.map((r) => String(r.id));
		}
		const reopen = (col: 'valid_to' | 'recorded_to', at: number | null): SqlStatement[] =>
			at === null
				? []
				: ['edge_versions', 'node_versions'].map((t) => ({
						sql: `UPDATE ${t} SET ${col} = ${FOREVER} WHERE ${col} > ?`,
						args: [at],
					}));
		stmts.push(
			{ sql: 'DELETE FROM node_analytics', args: [] },
			{ sql: 'DELETE FROM node_scores', args: [] },
			...(emb
				? [
						{
							// Kept only where the source's live version survives the cut.
							sql: `DELETE FROM node_embeddings WHERE id NOT IN (SELECT id FROM node_versions WHERE ${sourceLive} AND ${keep})`,
							args: [],
						},
					]
				: []),
			// Delete what the cut leaves behind BEFORE reopening, so a reopened version never
			// meets its own successor in a live-only unique index.
			{ sql: `DELETE FROM edge_versions WHERE NOT (${keep})`, args: [] },
			{ sql: `DELETE FROM node_versions WHERE NOT (${keep})`, args: [] },
			...reopen('recorded_to', cut.recordedAsOf),
			...reopen('valid_to', cut.asOf),
			{ sql: 'DELETE FROM edge_identity WHERE id NOT IN (SELECT id FROM edge_versions)', args: [] },
			{
				sql: `DELETE FROM node_identity WHERE id NOT IN (SELECT id FROM node_versions)
				      AND id NOT IN (SELECT src FROM edge_versions) AND id NOT IN (SELECT dst FROM edge_versions)`,
				args: [],
			},
			// External-content FTS5 keeps entries for deleted rows until it is rebuilt.
			{ sql: "INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')", args: [] },
		);
	}
	const blobTable = await tableExists(target, 'graphx_blobs');
	if (blobTable) {
		// A copy takes only the blobs its versions reference; so does the trimmed branch.
		stmts.push({
			sql: `DELETE FROM graphx_blobs WHERE '${BLOB_PREFIX}' || hash NOT IN (SELECT uri FROM node_versions WHERE uri IS NOT NULL)`,
			args: [],
		});
	}
	await target.batch(stmts, 'write');

	const count = async (t: string) =>
		num((await target.execute(`SELECT count(*) AS n FROM ${t}`)).rows[0]?.n ?? 0);
	const meta = (await target.execute('SELECT key, value FROM graph_meta')).rows;
	return {
		asOf: cut.asOf,
		recordedAsOf: cut.recordedAsOf,
		method: 'native',
		nodes: await count('node_identity'),
		nodeVersions: await count('node_versions'),
		edges: await count('edge_identity'),
		edgeVersions: await count('edge_versions'),
		vectors: emb ? await count('node_embeddings') : 0,
		blobs: blobTable ? await count('graphx_blobs') : 0,
		constraints: (await readConstraints(target, meta)).length,
		needsEmbedding,
	};
}

/** Copy a whole table, paged by OFFSET over its primary key. For the small side tables only. */
async function copyAll(
	source: DbClient,
	target: DbClient,
	table: string,
	cols: string,
	orderBy: string,
	pageSize: number,
): Promise<void> {
	const width = cols.split(',').length;
	for (let offset = 0; ; offset += pageSize) {
		const rows = (
			await source.execute({
				sql: `SELECT ${cols} FROM ${table} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
				args: [pageSize, offset],
			})
		).rows;
		if (rows.length === 0) return;
		const names = cols.split(',').map((c) => c.trim());
		const stmt: SqlStatement = {
			sql: `INSERT INTO ${table} (${cols}) VALUES ${placeholders(rows.length, width)}`,
			args: rows.flatMap((r) =>
				names.map((n) => {
					const v = r[n];
					return typeof v === 'bigint' ? Number(v) : (v as string | number | null);
				}),
			),
		};
		await target.execute(stmt);
		if (rows.length < pageSize) return;
	}
}
