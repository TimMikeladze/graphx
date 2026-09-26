/**
 * BunQL as a graphx backend — the embedded `bun:ffi` driver, and a BunQL *server* over Hrana.
 *
 * BunQL is a plain libsqlite3 (a pinned build with FTS5, RTREE, math, session, preupdate and
 * snapshot compiled in), so graphx speaks to it with the `sqlite` dialect it already has for
 * WASM and Expo — NOT `libsql`. The libSQL arm emits `F32_BLOB`, `libsql_vector_idx`,
 * `vector()` and `vector_top_k`, none of which exist outside libSQL's own fork; `init` would
 * fail on the embeddings DDL. Every client this module builds is therefore tagged
 * `dialect: 'sqlite'`, which means exact vector ranking (`retrieve.ts`) rather than ANN.
 *
 * Nothing here imports `@bunql/db`. The embedded driver is typed STRUCTURALLY — the same
 * trick `expo.ts` uses for Expo's SQLite module — so this subpath adds no dependency and the
 * host passes its own `Database`. The remote driver is `@libsql/client`, which graphx already
 * depends on, pointed at BunQL's Hrana surface.
 */

import process from 'node:process';
import { createClient } from '@libsql/client';
import { createConnectionClient, type ConnectionClient } from './connection.ts';
import { registerBunqlDriver, type DbConfig } from './db.ts';
import type {
	DbClient,
	DbTransaction,
	SqlResult,
	SqlRow,
	SqlStatement,
	TransactionMode,
} from './dialect.ts';

// ── the embedded driver (`@bunql/db/sqlite`) ────────────────────────────────────────────────

/** What BunQL's driver hands back out of SQLite. */
export type BunqlValue = number | bigint | string | Uint8Array | null;
/** What it accepts as a binding. `undefined` binds NULL there; graphx never sends one. */
export type BunqlBindValue = BunqlValue | boolean | ArrayBuffer | ArrayBufferView | undefined;
/** Named parameters, with or without the `:`, `@` or `$` prefix. */
export type BunqlNamedParams = Record<string, BunqlBindValue>;
/** One argument to a statement verb: a positional value, or — alone — a named-parameter object. */
export type BunqlBindArg = BunqlBindValue | BunqlNamedParams;

export interface BunqlRunResult {
	changes: number | bigint;
	lastInsertRowid: number | bigint;
}

/**
 * Structural subset of `@bunql/db/sqlite`'s `Statement`. Statements are CACHED by the
 * `Database` that compiled them, so this driver never finalizes one — `all()` resets the
 * cursor itself, and finalizing would poison the host's cache.
 */
export interface BunqlStatement {
	readonly columnNames: string[];
	readonly readonly: boolean;
	all(...params: BunqlBindArg[]): Record<string, BunqlValue>[];
	run(...params: BunqlBindArg[]): BunqlRunResult;
}

/** Reads the row a preupdate hook is being told about. */
export interface BunqlPreupdateAccessor {
	count(): number;
	old(i: number): BunqlValue;
	new (i: number): BunqlValue;
}

/** Return `false` to turn the commit into a rollback. */
export type BunqlCommitHook = () => boolean | void;
export type BunqlUpdateHook = (op: number, dbName: string, table: string, rowid: bigint) => void;
export type BunqlPreupdateHook = (
	op: number,
	dbName: string,
	table: string,
	oldRowid: bigint,
	newRowid: bigint,
	accessor: BunqlPreupdateAccessor,
) => void;
/** `0` allows the action, `1` denies it, `2` makes it a no-op. */
export type BunqlAuthorizer = (
	action: number,
	arg1: string | null,
	arg2: string | null,
	dbName: string | null,
	trigger: string | null,
) => number;

/**
 * Structural subset of `@bunql/db/sqlite`'s `Database` — an exclusively owned connection.
 * `safeIntegers` must be true: with it off, BunQL reads INTEGER columns through the narrow FFI
 * symbol, which silently rounds anything past 2^53.
 *
 * The hooks are here because they are the point of the embedded seam: a commit hook is a change
 * feed graphx does not have to poll for, and the authorizer puts a tenant's table ACL inside
 * SQLite. graphx itself installs none of them — {@link BunqlLocalClient.database} hands the
 * connection to the host, which does.
 */
export interface BunqlDatabase {
	readonly safeIntegers: boolean;
	readonly closed: boolean;
	readonly changes: number | bigint;
	readonly lastInsertRowid: number | bigint;
	prepare(sql: string): BunqlStatement;
	exec(sql: string): void;
	/** Abort any statement running on this connection (from a signal handler or another thread). */
	interrupt(): void;
	/** Wall-clock ceiling for every statement, enforced by SQLite's progress handler. */
	deadline(ms: number | null): void;
	/** After every commit on this connection; `false` turns the commit into a rollback. */
	onCommit(cb: BunqlCommitHook | null): void;
	onRollback(cb: (() => void) | null): void;
	/** After each changed row, with its rowid. */
	onUpdate(cb: BunqlUpdateHook | null): void;
	/** Before each changed row, with the old and new values still readable. */
	onPreupdate(cb: BunqlPreupdateHook | null): void;
	/** Consulted for every action a statement takes. */
	authorizer(cb: BunqlAuthorizer | null): void;
	close(): void;
}

export interface BunqlOpenOptions {
	/** Statement-cache ceiling. Past it, every `prepare` compiles and finalizes a victim. */
	statementCache?: number;
	busyTimeoutMs?: number;
	safeIntegers?: boolean;
	wal?: boolean;
	readonly?: boolean;
	create?: boolean;
}

/** Structural subset of the `@bunql/db/sqlite` module: `Database.open` is all this needs. */
export interface BunqlModule {
	readonly Database: {
		open(path: string, options?: BunqlOpenOptions): BunqlDatabase;
	};
}

/** An owned embedded BunQL connection, plus the capabilities graphx has no other driver for. */
export interface BunqlLocalClient extends ConnectionClient {
	/** The connection itself — for commit/preupdate hooks, an authorizer, changeset sessions. */
	readonly database: BunqlDatabase;
	/** Abort whatever is running: a runaway traversal or recursive algorithm. */
	interrupt(): void;
	/** Statement deadline, in ms; `null` clears it. */
	deadline(ms: number | null): void;
}

/** The exact unbound statements `createConnectionClient` issues for transaction control. */
const TX_CONTROL = new Set(['BEGIN IMMEDIATE', 'BEGIN DEFERRED', 'COMMIT', 'ROLLBACK']);

function bindValue(value: unknown): BunqlBindValue {
	if (value === null || typeof value === 'string') return value;
	if (typeof value === 'boolean') return Number(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
			throw new TypeError('BunQL binding requires a finite number with safe integer precision');
		}
		return value;
	}
	if (typeof value === 'bigint') {
		if (value < -(1n << 63n) || value >= 1n << 63n)
			throw new RangeError('BunQL integer bindings must fit signed 64 bits');
		return value;
	}
	if (value instanceof Date) return bindValue(value.getTime());
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	}
	throw new TypeError('Unsupported BunQL binding');
}

function bindArgs(input: SqlStatement): BunqlBindArg[] {
	if (typeof input === 'string') return [];
	const args = input.args ?? [];
	if (Array.isArray(args)) return args.map(bindValue);
	// BunQL accepts a named-parameter key with or without its `:`/`@`/`$` prefix, so graphx's
	// bare names pass through as they are.
	return [
		Object.fromEntries(Object.entries(args).map(([key, value]) => [key, bindValue(value)])),
	] as BunqlBindArg[];
}

/** `safeIntegers` means every INTEGER arrives as a bigint; narrow it the way libSQL's driver does. */
function outputValue(value: BunqlValue): unknown {
	if (typeof value === 'bigint') {
		if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new RangeError(
				'Received integer which cannot be safely represented as a JavaScript number',
			);
		}
		return Number(value);
	}
	return value;
}

function row(input: Record<string, BunqlValue>): SqlRow {
	return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, outputValue(value)]));
}

function bigintCount(value: number | bigint, context: string): bigint {
	if (typeof value === 'bigint') return value;
	if (!Number.isSafeInteger(value)) throw new RangeError(`BunQL reported an unsafe ${context}`);
	return BigInt(value);
}

/**
 * Take exclusive ownership of an already opened embedded BunQL connection.
 *
 * The caller keeps nothing: this client serializes every statement on the connection, owns
 * `BEGIN`/`COMMIT`/`ROLLBACK`, and closes the `Database` when it closes. Use {@link openBunqlDb}
 * for a configured persistent file. The connection must have been opened with
 * `safeIntegers: true`, and — because graphx's schema declares foreign keys — with them ON;
 * `openBunqlDb` does both.
 *
 * Statements are cached by the `Database`, so a hot graph compiles each SQL text once. Nothing
 * here finalizes one.
 */
export function createBunqlClient(database: BunqlDatabase): BunqlLocalClient {
	if (!database.safeIntegers) {
		throw new TypeError(
			'createBunqlClient: open the Database with { safeIntegers: true } — BunQL otherwise reads INTEGER columns through the narrow FFI symbol and rounds past 2^53',
		);
	}
	const client = createConnectionClient(
		{
			async execute(input): Promise<SqlResult> {
				const sql = typeof input === 'string' ? input : input.sql;
				// Transaction control arrives unbound and exactly once per lease; `exec` keeps it
				// out of the statement cache, which is sized for the graph's own SQL.
				if (typeof input === 'string' && TX_CONTROL.has(sql)) {
					database.exec(sql);
					return { rows: [], columns: [], rowsAffected: 0 };
				}
				const statement = database.prepare(sql);
				// `all` on a writer is the RETURNING-safe verb: it drains the cursor (so a
				// RETURNING clause is not discarded the way `run` discards it) and resets.
				const rows = statement.all(...bindArgs(input)).map(row);
				return {
					rows,
					columns: statement.columnNames,
					// Read after draining: `changes()` is only final once the statement is done.
					rowsAffected: statement.readonly ? 0 : Number(outputValue(database.changes)),
					lastInsertRowid: bigintCount(database.lastInsertRowid, 'rowid'),
				};
			},
			executeMultiple: async (sql) => database.exec(sql),
			close: () => database.close(),
		},
		'sqlite',
	) as BunqlLocalClient;
	return Object.defineProperties(client, {
		database: { value: database, enumerable: true },
		interrupt: { value: () => database.interrupt(), enumerable: true },
		deadline: { value: (ms: number | null) => database.deadline(ms), enumerable: true },
	}) as BunqlLocalClient;
}

async function openConfigured(
	database: BunqlDatabase,
	persistent: boolean,
): Promise<BunqlLocalClient> {
	const client = createBunqlClient(database);
	try {
		await client.execute('PRAGMA foreign_keys = ON');
		await client.execute(`PRAGMA busy_timeout = ${client.busyTimeoutMs ?? 5000}`);
		await client.execute(`PRAGMA journal_mode = ${persistent ? 'WAL' : 'MEMORY'}`);
		await client.execute('PRAGMA synchronous = FULL');
		if (!persistent) await client.execute('PRAGMA temp_store = MEMORY');
		for (const [pragma, column, expected] of [
			['journal_mode', 'journal_mode', persistent ? 'wal' : 'memory'],
			['synchronous', 'synchronous', 2],
			['foreign_keys', 'foreign_keys', 1],
		] as const) {
			const actual = (await client.execute(`PRAGMA ${pragma}`)).rows[0]?.[column];
			if (actual !== expected)
				throw new Error(
					`BunQL failed to configure ${pragma} (expected ${String(expected)}, received ${String(actual)})`,
				);
		}
		const file = (await client.execute('PRAGMA database_list')).rows.find(
			(entry) => entry.name === 'main',
		)?.file;
		if (persistent ? typeof file !== 'string' || file === '' : file !== '')
			throw new Error(
				persistent
					? 'openBunqlDb did not open a persistent file'
					: 'openBunqlMemoryDb did not open a RAM-only namespace',
			);
		return client;
	} catch (error) {
		try {
			await client.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], 'BunQL initialization and close failed');
		}
		throw error;
	}
}

/**
 * Open one exclusively owned embedded BunQL database file, in WAL with FULL sync, foreign keys
 * ON and a 5 s busy timeout — verified, not assumed. Pass the `@bunql/db/sqlite` module; this
 * subpath never imports it, so `@bunql/db` stays an optional peer.
 *
 * ```ts
 * import * as bunql from '@bunql/db/sqlite';
 * const db = await openBunqlDb(bunql, '/var/lib/graphx/acme__alpha.db');
 * await init(db, embedder);
 * ```
 *
 * Call `init(client, embedder?)` afterwards, and await `close()` to observe rollback and
 * physical-close failures.
 */
export async function openBunqlDb(
	module: BunqlModule,
	filename: string,
	opts: BunqlOpenOptions = {},
): Promise<BunqlLocalClient> {
	if (!filename || filename.includes('\0') || filename === ':memory:') {
		throw new TypeError('openBunqlDb requires a persistent filesystem path');
	}
	// `wal: false` would leave the file in the journal mode it already had; this driver states it.
	return openConfigured(
		module.Database.open(filename, { ...opts, safeIntegers: true, wal: false }),
		true,
	);
}

/** Open one private, RAM-only embedded BunQL namespace. Nothing is shared with another call. */
export async function openBunqlMemoryDb(
	module: BunqlModule,
	opts: BunqlOpenOptions = {},
): Promise<BunqlLocalClient> {
	return openConfigured(
		module.Database.open(':memory:', { ...opts, safeIntegers: true, wal: false }),
		false,
	);
}

// ── the remote driver (a BunQL server, over Hrana) ──────────────────────────────────────────

/** BunQL's own database-name rule (`src/tenant/tenant.ts`), applied before a round trip. */
const BUNQL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface BunqlRemoteOptions {
	/** The server's origin, e.g. `http://127.0.0.1:4321` or `https://sql.example.com`. */
	url: string;
	/** The BunQL database (graphx's `db_namespace`). Lower case, `[a-z0-9][a-z0-9_-]{0,63}`. */
	database: string;
	/** An admin key or a minted token; travels as `Authorization: Bearer`. */
	authToken?: string;
	/** libSQL's integer mode. Default `'number'`, as graphx's own libSQL path uses. */
	intMode?: 'number' | 'bigint' | 'string';
	/**
	 * Create the database on first use when the server does not have it. Default true, which is
	 * what the other multi-tenant backends do — the Postgres adapter creates the tenant's schema
	 * and DuckDB creates the file, so `getDb(ns)` + `init(db)` provisions a namespace on all of
	 * them. BunQL has no create-on-demand of its own: `POST /v1/db` is an ADMIN route, so
	 * `authToken` (or {@link adminToken}) has to be an admin key for this to work. Set it false
	 * when namespaces are provisioned outside graphx.
	 */
	ensureDatabase?: boolean;
	/** The admin key used for that creation. Defaults to {@link authToken}. */
	adminToken?: string;
	/**
	 * Turn `foreignKeys` on for that database as it is created. Default true: graphx's schema
	 * declares foreign keys and relies on them being enforced, BunQL defaults `[sqlite]
	 * foreignKeys` off, and a tenant statement cannot turn a pragma on.
	 */
	foreignKeys?: boolean;
}

/** A graphx client over a BunQL server. Tagged `sqlite`, and the server owns its pragmas. */
export interface BunqlRemoteClient extends DbClient {
	readonly dialect: 'sqlite';
	readonly managedPragmas: true;
}

/**
 * A graphx namespace as a BunQL database name: case-folded, then validated.
 *
 * BunQL names are lower case (`[a-z0-9][a-z0-9_-]{0,63}`) and a graphx namespace need not be —
 * `evt_01M3E2K3W0…` pairs a lower-case prefix with a ULID, which is upper-case by construction.
 * Folding is safe rather than merely convenient: BunQL keeps a directory per database, and on a
 * case-insensitive filesystem two names differing only in case are one directory — which is why
 * the rule is lower case in the first place. So a pair of namespaces that fold together could
 * never have been two BunQL databases anyway.
 */
export function bunqlDatabaseName(namespace: string): string {
	const folded = namespace.toLowerCase();
	if (!BUNQL_NAME.test(folded)) {
		throw new TypeError(
			`graphx namespace ${JSON.stringify(namespace)} is not a usable BunQL database name: expected [a-z0-9][a-z0-9_-]{0,63} after case folding`,
		);
	}
	return folded;
}

/** `origin` + database → the Hrana base URL. The trailing slash is load-bearing: `@libsql/core`
 *  resolves `v2/pipeline` RELATIVELY, so without it the last path segment is discarded and the
 *  request becomes `/v1/db/v2/pipeline` — a bare 404. */
export function bunqlHranaUrl(origin: string, database: string): string {
	if (database !== bunqlDatabaseName(database)) {
		throw new TypeError(
			`BunQL database name ${JSON.stringify(database)} is invalid: expected [a-z0-9][a-z0-9_-]{0,63}`,
		);
	}
	const base = new URL(origin);
	if (base.search || base.hash)
		throw new TypeError('BunQL server URL must be an origin, without a query or fragment');
	const path = base.pathname.replace(/\/+$/, '');
	if (path.includes('/v1/db/'))
		throw new TypeError('Pass the BunQL server origin; the driver appends /v1/db/<database>/');
	base.pathname = `${path}/v1/db/${database}/`;
	return base.toString();
}

/**
 * A graphx client over a running BunQL server, through its libsql-compatible Hrana surface.
 *
 * Two things differ from pointing `@libsql/client` at a libSQL server, and both are why this
 * wrapper exists rather than a bare `createClient`:
 *
 * 1. It is tagged `dialect: 'sqlite'`. An untagged client reads as `libsql` and graphx emits
 *    vector SQL a plain libsqlite3 has never heard of.
 * 2. It is tagged `managedPragmas`. BunQL's authorizer answers `SQLITE_DENY` to a pragma in its
 *    setting form, so graphx must not issue `PRAGMA foreign_keys = ON` / `busy_timeout`. The
 *    server states both itself — and `[sqlite] foreignKeys` defaults to FALSE in BunQL, while
 *    graphx's schema declares foreign keys, so a node serving graphx has to turn it on.
 *
 * Writes must address the primary: a replica's Hrana surface answers `NOT_PRIMARY` rather than
 * forwarding.
 */
export function createBunqlRemoteClient(input: BunqlRemoteOptions): BunqlRemoteClient {
	// Fold once, here, so the Hrana URL and the admin routes always name the same database.
	const opts: BunqlRemoteOptions = { ...input, database: bunqlDatabaseName(input.database) };
	const raw = createClient({
		url: bunqlHranaUrl(opts.url, opts.database),
		...(opts.authToken ? { authToken: opts.authToken } : {}),
		intMode: opts.intMode ?? 'number',
	});
	// Provisioning is deferred to the first statement and memoized: a client that is built and
	// never used costs no round trip, and concurrent first statements provision once.
	let provisioned: Promise<void> | undefined;
	const ensure = (): Promise<void> => {
		if (opts.ensureDatabase === false) return Promise.resolve();
		provisioned ??= ensureDatabase(opts);
		return provisioned;
	};
	// Delegated method by method, never spread: `@libsql/client`'s clients are class
	// instances, so `{ ...raw }` would copy the fields and drop every method.
	return {
		dialect: 'sqlite',
		managedPragmas: true,
		execute: async (stmt: SqlStatement) => {
			await ensure();
			return raw.execute(stmt);
		},
		batch: async (stmts: SqlStatement[], mode?: TransactionMode) => {
			await ensure();
			return raw.batch(stmts, mode);
		},
		transaction: async (mode?: TransactionMode): Promise<DbTransaction> => {
			await ensure();
			return raw.transaction(mode);
		},
		executeMultiple: async (sql: string) => {
			await ensure();
			return raw.executeMultiple(sql);
		},
		close: () => raw.close(),
	};
}

async function admin(opts: BunqlRemoteOptions, path: string, init: RequestInit): Promise<Response> {
	const token = opts.adminToken ?? opts.authToken;
	return fetch(new URL(path, opts.url), {
		...init,
		headers: {
			'content-type': 'application/json',
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
}

/**
 * `POST /v1/db`, then `PATCH /v1/db/{db}` for foreign keys. A 409 means another writer (or a
 * previous run) already created it, which is success — so two graphx processes starting at once
 * both proceed.
 */
async function ensureDatabase(opts: BunqlRemoteOptions): Promise<void> {
	const created = await admin(opts, '/v1/db', {
		method: 'POST',
		body: JSON.stringify({ name: opts.database }),
	});
	if (!created.ok && created.status !== 409) {
		throw new Error(
			`BunQL: could not create the database ${opts.database} (${created.status} ${await created.text()}). Creating one is an admin route — pass an admin key as authToken/adminToken, or provision namespaces yourself and pass ensureDatabase: false.`,
		);
	}
	if (opts.foreignKeys === false) return;
	// Only for a database this call created: an existing one may be in use, and turning foreign
	// keys on closes and reopens it, which ends everything open on it the way an eviction does.
	if (created.status === 409) return;
	const configured = await admin(opts, `/v1/db/${opts.database}`, {
		method: 'PATCH',
		body: JSON.stringify({ foreignKeys: true }),
	});
	if (!configured.ok) {
		throw new Error(
			`BunQL: could not turn foreign keys on for ${opts.database} (${configured.status} ${await configured.text()}). graphx's schema declares them; set the node's [sqlite] foreignKeys instead, or pass foreignKeys: false to accept unenforced references.`,
		);
	}
}

/**
 * The `driver: 'bunql'` factory behind {@link import('./db.ts').getDb} — a server URL from
 * `bunqlUrl` (or `GRAPHX_BUNQL_URL`) and a token from `authToken` (or `GRAPHX_BUNQL_TOKEN`),
 * with the namespace as the BunQL database name.
 */
export function bunqlDriver(namespace: string, cfg: DbConfig): DbClient {
	const url = cfg.bunqlUrl ?? process.env.GRAPHX_BUNQL_URL;
	if (!url) {
		throw new Error(
			"getDb: the bunql driver needs a server URL — pass { bunqlUrl } or set GRAPHX_BUNQL_URL (e.g. 'http://127.0.0.1:4321')",
		);
	}
	return createBunqlRemoteClient({
		url,
		database: namespace,
		authToken: cfg.authToken ?? process.env.GRAPHX_BUNQL_TOKEN,
		adminToken: process.env.GRAPHX_BUNQL_ADMIN_TOKEN,
	});
}

// Registered on import, exactly as `pg.ts` and `duck.ts` register theirs — so `getDb` can serve
// `driver: 'bunql'` for a consumer who imported this subpath, and nobody else pays for it.
registerBunqlDriver(bunqlDriver);
