/**
 * bql.sh as a graphx backend — the embedded `bun:ffi` driver, and a bql.sh *server* over Hrana.
 *
 * bql.sh is a plain libsqlite3 (a pinned build with FTS5, RTREE, math, session, preupdate and
 * snapshot compiled in), so graphx speaks to it with the `sqlite` dialect it already has for
 * WASM and Expo — NOT `libsql`. The libSQL arm emits `F32_BLOB`, `libsql_vector_idx`,
 * `vector()` and `vector_top_k`, none of which exist outside libSQL's own fork; `init` would
 * fail on the embeddings DDL. Every client this module builds is therefore tagged
 * `dialect: 'sqlite'`, which means exact vector ranking (`retrieve.ts`) rather than ANN.
 *
 * Nothing here imports `bql.sh`. The embedded driver is typed STRUCTURALLY — the same
 * trick `expo.ts` uses for Expo's SQLite module — so this subpath adds no dependency and the
 * host passes its own `Database`. The remote driver is `@libsql/client`, which graphx already
 * depends on, pointed at bql.sh's Hrana surface.
 */

import process from 'node:process';
import { createClient } from '@libsql/client';
import { createConnectionClient, type ConnectionClient } from './connection.ts';
import { registerBqlDriver, type DbConfig } from './db.ts';
import type {
	DbClient,
	DbTransaction,
	SqlResult,
	SqlRow,
	SqlStatement,
	TransactionMode,
} from './dialect.ts';
import { ForkError, type NativeBranch, type NativeFork } from './fork.ts';

// ── the embedded driver (`bql.sh/sqlite`) ────────────────────────────────────────────────

/** What bql.sh's driver hands back out of SQLite. */
export type BqlValue = number | bigint | string | Uint8Array | null;
/** What it accepts as a binding. `undefined` binds NULL there; graphx never sends one. */
export type BqlBindValue = BqlValue | boolean | ArrayBuffer | ArrayBufferView | undefined;
/** Named parameters, with or without the `:`, `@` or `$` prefix. */
export type BqlNamedParams = Record<string, BqlBindValue>;
/** One argument to a statement verb: a positional value, or — alone — a named-parameter object. */
export type BqlBindArg = BqlBindValue | BqlNamedParams;

export interface BqlRunResult {
	changes: number | bigint;
	lastInsertRowid: number | bigint;
}

/**
 * Structural subset of `bql.sh/sqlite`'s `Statement`. Statements are CACHED by the
 * `Database` that compiled them, so this driver never finalizes one — `all()` resets the
 * cursor itself, and finalizing would poison the host's cache.
 */
export interface BqlStatement {
	readonly columnNames: string[];
	readonly readonly: boolean;
	all(...params: BqlBindArg[]): Record<string, BqlValue>[];
	run(...params: BqlBindArg[]): BqlRunResult;
}

/** Reads the row a preupdate hook is being told about. */
export interface BqlPreupdateAccessor {
	count(): number;
	old(i: number): BqlValue;
	new (i: number): BqlValue;
}

/** Return `false` to turn the commit into a rollback. */
export type BqlCommitHook = () => boolean | void;
export type BqlUpdateHook = (op: number, dbName: string, table: string, rowid: bigint) => void;
export type BqlPreupdateHook = (
	op: number,
	dbName: string,
	table: string,
	oldRowid: bigint,
	newRowid: bigint,
	accessor: BqlPreupdateAccessor,
) => void;
/** `0` allows the action, `1` denies it, `2` makes it a no-op. */
export type BqlAuthorizer = (
	action: number,
	arg1: string | null,
	arg2: string | null,
	dbName: string | null,
	trigger: string | null,
) => number;

/**
 * Structural subset of `bql.sh/sqlite`'s `Database` — an exclusively owned connection.
 * `safeIntegers` must be true: with it off, bql.sh reads INTEGER columns through the narrow FFI
 * symbol, which silently rounds anything past 2^53.
 *
 * The hooks are here because they are the point of the embedded seam: a commit hook is a change
 * feed graphx does not have to poll for, and the authorizer puts a tenant's table ACL inside
 * SQLite. graphx itself installs none of them — {@link BqlLocalClient.database} hands the
 * connection to the host, which does.
 */
export interface BqlDatabase {
	readonly safeIntegers: boolean;
	readonly closed: boolean;
	readonly changes: number | bigint;
	readonly lastInsertRowid: number | bigint;
	prepare(sql: string): BqlStatement;
	exec(sql: string): void;
	/** Abort any statement running on this connection (from a signal handler or another thread). */
	interrupt(): void;
	/** Wall-clock ceiling for every statement, enforced by SQLite's progress handler. */
	deadline(ms: number | null): void;
	/** After every commit on this connection; `false` turns the commit into a rollback. */
	onCommit(cb: BqlCommitHook | null): void;
	onRollback(cb: (() => void) | null): void;
	/** After each changed row, with its rowid. */
	onUpdate(cb: BqlUpdateHook | null): void;
	/** Before each changed row, with the old and new values still readable. */
	onPreupdate(cb: BqlPreupdateHook | null): void;
	/** Consulted for every action a statement takes. */
	authorizer(cb: BqlAuthorizer | null): void;
	close(): void;
}

export interface BqlOpenOptions {
	/** Statement-cache ceiling. Past it, every `prepare` compiles and finalizes a victim. */
	statementCache?: number;
	busyTimeoutMs?: number;
	safeIntegers?: boolean;
	wal?: boolean;
	readonly?: boolean;
	create?: boolean;
}

/** Structural subset of the `bql.sh/sqlite` module: `Database.open` is all this needs. */
export interface BqlModule {
	readonly Database: {
		open(path: string, options?: BqlOpenOptions): BqlDatabase;
	};
}

/** An owned embedded bql.sh connection, plus the capabilities graphx has no other driver for. */
export interface BqlLocalClient extends ConnectionClient {
	/** The connection itself — for commit/preupdate hooks, an authorizer, changeset sessions. */
	readonly database: BqlDatabase;
	/** Abort whatever is running: a runaway traversal or recursive algorithm. */
	interrupt(): void;
	/** Statement deadline, in ms; `null` clears it. */
	deadline(ms: number | null): void;
}

/** The exact unbound statements `createConnectionClient` issues for transaction control. */
const TX_CONTROL = new Set(['BEGIN IMMEDIATE', 'BEGIN DEFERRED', 'COMMIT', 'ROLLBACK']);

function bindValue(value: unknown): BqlBindValue {
	if (value === null || typeof value === 'string') return value;
	if (typeof value === 'boolean') return Number(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
			throw new TypeError('bql.sh binding requires a finite number with safe integer precision');
		}
		return value;
	}
	if (typeof value === 'bigint') {
		if (value < -(1n << 63n) || value >= 1n << 63n)
			throw new RangeError('bql.sh integer bindings must fit signed 64 bits');
		return value;
	}
	if (value instanceof Date) return bindValue(value.getTime());
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	}
	throw new TypeError('Unsupported bql.sh binding');
}

function bindArgs(input: SqlStatement): BqlBindArg[] {
	if (typeof input === 'string') return [];
	const args = input.args ?? [];
	if (Array.isArray(args)) return args.map(bindValue);
	// bql.sh accepts a named-parameter key with or without its `:`/`@`/`$` prefix, so graphx's
	// bare names pass through as they are.
	return [
		Object.fromEntries(Object.entries(args).map(([key, value]) => [key, bindValue(value)])),
	] as BqlBindArg[];
}

/** `safeIntegers` means every INTEGER arrives as a bigint; narrow it the way libSQL's driver does. */
function outputValue(value: BqlValue): unknown {
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

function row(input: Record<string, BqlValue>): SqlRow {
	return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, outputValue(value)]));
}

function bigintCount(value: number | bigint, context: string): bigint {
	if (typeof value === 'bigint') return value;
	if (!Number.isSafeInteger(value)) throw new RangeError(`bql.sh reported an unsafe ${context}`);
	return BigInt(value);
}

/**
 * Take exclusive ownership of an already opened embedded bql.sh connection.
 *
 * The caller keeps nothing: this client serializes every statement on the connection, owns
 * `BEGIN`/`COMMIT`/`ROLLBACK`, and closes the `Database` when it closes. Use {@link openBqlDb}
 * for a configured persistent file. The connection must have been opened with
 * `safeIntegers: true`, and — because graphx's schema declares foreign keys — with them ON;
 * `openBqlDb` does both.
 *
 * Statements are cached by the `Database`, so a hot graph compiles each SQL text once. Nothing
 * here finalizes one.
 */
export function createBqlClient(database: BqlDatabase): BqlLocalClient {
	if (!database.safeIntegers) {
		throw new TypeError(
			'createBqlClient: open the Database with { safeIntegers: true } — bql.sh otherwise reads INTEGER columns through the narrow FFI symbol and rounds past 2^53',
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
	) as BqlLocalClient;
	return Object.defineProperties(client, {
		database: { value: database, enumerable: true },
		interrupt: { value: () => database.interrupt(), enumerable: true },
		deadline: { value: (ms: number | null) => database.deadline(ms), enumerable: true },
	}) as BqlLocalClient;
}

async function openConfigured(database: BqlDatabase, persistent: boolean): Promise<BqlLocalClient> {
	const client = createBqlClient(database);
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
					`bql.sh failed to configure ${pragma} (expected ${String(expected)}, received ${String(actual)})`,
				);
		}
		const file = (await client.execute('PRAGMA database_list')).rows.find(
			(entry) => entry.name === 'main',
		)?.file;
		if (persistent ? typeof file !== 'string' || file === '' : file !== '')
			throw new Error(
				persistent
					? 'openBqlDb did not open a persistent file'
					: 'openBqlMemoryDb did not open a RAM-only namespace',
			);
		return client;
	} catch (error) {
		try {
			await client.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], 'bql.sh initialization and close failed');
		}
		throw error;
	}
}

/**
 * Open one exclusively owned embedded bql.sh database file, in WAL with FULL sync, foreign keys
 * ON and a 5 s busy timeout — verified, not assumed. Pass the `bql.sh/sqlite` module; this
 * subpath never imports it, so `bql.sh` stays an optional peer.
 *
 * ```ts
 * import * as bql from 'bql.sh/sqlite';
 * const db = await openBqlDb(bql, '/var/lib/graphx/acme__alpha.db');
 * await init(db, embedder);
 * ```
 *
 * Call `init(client, embedder?)` afterwards, and await `close()` to observe rollback and
 * physical-close failures.
 */
export async function openBqlDb(
	module: BqlModule,
	filename: string,
	opts: BqlOpenOptions = {},
): Promise<BqlLocalClient> {
	if (!filename || filename.includes('\0') || filename === ':memory:') {
		throw new TypeError('openBqlDb requires a persistent filesystem path');
	}
	// `wal: false` would leave the file in the journal mode it already had; this driver states it.
	return openConfigured(
		module.Database.open(filename, { ...opts, safeIntegers: true, wal: false }),
		true,
	);
}

/** Open one private, RAM-only embedded bql.sh namespace. Nothing is shared with another call. */
export async function openBqlMemoryDb(
	module: BqlModule,
	opts: BqlOpenOptions = {},
): Promise<BqlLocalClient> {
	return openConfigured(
		module.Database.open(':memory:', { ...opts, safeIntegers: true, wal: false }),
		false,
	);
}

// ── the remote driver (a bql.sh server, over Hrana) ──────────────────────────────────────────

/** bql.sh's own database-name rule (`src/tenant/tenant.ts`), applied before a round trip. */
const BQL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface BqlRemoteOptions {
	/** The server's origin, e.g. `http://127.0.0.1:4321` or `https://sql.example.com`. */
	url: string;
	/** The bql.sh database (graphx's `db_namespace`). Lower case, `[a-z0-9][a-z0-9_-]{0,63}`. */
	database: string;
	/** An admin key or a minted token; travels as `Authorization: Bearer`. */
	authToken?: string;
	/** libSQL's integer mode. Default `'number'`, as graphx's own libSQL path uses. */
	intMode?: 'number' | 'bigint' | 'string';
	/**
	 * Create the database on first use when the server does not have it. Default true, which is
	 * what the other multi-tenant backends do — the Postgres adapter creates the tenant's schema
	 * and DuckDB creates the file, so `getDb(ns)` + `init(db)` provisions a namespace on all of
	 * them. bql.sh has no create-on-demand of its own: `POST /v1/db` is an ADMIN route, so
	 * `authToken` (or {@link adminToken}) has to be an admin key for this to work. Set it false
	 * when namespaces are provisioned outside graphx.
	 */
	ensureDatabase?: boolean;
	/** The admin key used for that creation. Defaults to {@link authToken}. */
	adminToken?: string;
	/**
	 * Turn `foreignKeys` on for that database as it is created. Default true: graphx's schema
	 * declares foreign keys and relies on them being enforced, bql.sh defaults `[sqlite]
	 * foreignKeys` off, and a tenant statement cannot turn a pragma on.
	 */
	foreignKeys?: boolean;
}

/** A graphx client over a bql.sh server. Tagged `sqlite`, and the server owns its pragmas. */
export interface BqlRemoteClient extends DbClient, NativeFork {
	readonly dialect: 'sqlite';
	readonly managedPragmas: true;
}

/** Each remote client's options, so one client can recognise another's server, and a switch for
 *  whether its database still needs provisioning — off once a native fork created it, on again
 *  when that branch is discarded. */
const remotes = new WeakMap<
	DbClient,
	{ opts: BqlRemoteOptions; provisioned(done: boolean): void }
>();

/**
 * A graphx namespace as a bql.sh database name: case-folded, then validated.
 *
 * bql.sh names are lower case (`[a-z0-9][a-z0-9_-]{0,63}`) and a graphx namespace need not be —
 * `evt_01M3E2K3W0…` pairs a lower-case prefix with a ULID, which is upper-case by construction.
 * Folding is safe rather than merely convenient: bql.sh keeps a directory per database, and on a
 * case-insensitive filesystem two names differing only in case are one directory — which is why
 * the rule is lower case in the first place. So a pair of namespaces that fold together could
 * never have been two bql.sh databases anyway.
 */
export function bqlDatabaseName(namespace: string): string {
	const folded = namespace.toLowerCase();
	if (!BQL_NAME.test(folded)) {
		throw new TypeError(
			`graphx namespace ${JSON.stringify(namespace)} is not a usable bql.sh database name: expected [a-z0-9][a-z0-9_-]{0,63} after case folding`,
		);
	}
	return folded;
}

/** `origin` + database → the Hrana base URL. The trailing slash is load-bearing: `@libsql/core`
 *  resolves `v2/pipeline` RELATIVELY, so without it the last path segment is discarded and the
 *  request becomes `/v1/db/v2/pipeline` — a bare 404. */
export function bqlHranaUrl(origin: string, database: string): string {
	if (database !== bqlDatabaseName(database)) {
		throw new TypeError(
			`bql.sh database name ${JSON.stringify(database)} is invalid: expected [a-z0-9][a-z0-9_-]{0,63}`,
		);
	}
	const base = new URL(origin);
	if (base.search || base.hash)
		throw new TypeError('bql.sh server URL must be an origin, without a query or fragment');
	const path = base.pathname.replace(/\/+$/, '');
	if (path.includes('/v1/db/'))
		throw new TypeError('Pass the bql.sh server origin; the driver appends /v1/db/<database>/');
	base.pathname = `${path}/v1/db/${database}/`;
	return base.toString();
}

/**
 * A graphx client over a running bql.sh server, through its libsql-compatible Hrana surface.
 *
 * Two things differ from pointing `@libsql/client` at a libSQL server, and both are why this
 * wrapper exists rather than a bare `createClient`:
 *
 * 1. It is tagged `dialect: 'sqlite'`. An untagged client reads as `libsql` and graphx emits
 *    vector SQL a plain libsqlite3 has never heard of.
 * 2. It is tagged `managedPragmas`. bql.sh's authorizer answers `SQLITE_DENY` to a pragma in its
 *    setting form, so graphx must not issue `PRAGMA foreign_keys = ON` / `busy_timeout`. The
 *    server states both itself — and `[sqlite] foreignKeys` defaults to FALSE in bql.sh, while
 *    graphx's schema declares foreign keys, so a node serving graphx has to turn it on.
 *
 * Writes must address the primary: a replica's Hrana surface answers `NOT_PRIMARY` rather than
 * forwarding.
 */
export function createBqlRemoteClient(input: BqlRemoteOptions): BqlRemoteClient {
	// Fold once, here, so the Hrana URL and the admin routes always name the same database.
	const opts: BqlRemoteOptions = { ...input, database: bqlDatabaseName(input.database) };
	const raw = createClient({
		url: bqlHranaUrl(opts.url, opts.database),
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
	const client: BqlRemoteClient = {
		dialect: 'sqlite',
		managedPragmas: true,
		nativeFork: async (target: DbClient) => {
			await ensure();
			return forkOnServer(opts, target);
		},
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
	remotes.set(client, {
		opts,
		provisioned: (done) => {
			provisioned = done ? Promise.resolve() : undefined;
		},
	});
	return client;
}

/** `http://Host:80/` and `http://host` are one server. */
function sameOrigin(a: string, b: string): boolean {
	return new URL(a).origin === new URL(b).origin;
}

/**
 * Fork `source`'s database into `target`'s with bql.sh's own fork — `POST /v1/db` with `from` —
 * when both are databases on one server and the target does not exist yet. Returns null, having
 * changed nothing, whenever that does not apply, so `fork()` copies instead: another backend or
 * server, a target that exists (even empty: deleting it is not this call's to do), or a token that
 * may not create databases.
 */
async function forkOnServer(
	source: BqlRemoteOptions,
	target: DbClient,
): Promise<NativeBranch | null> {
	const remote = remotes.get(target);
	if (!remote) return null;
	const into = remote.opts;
	if (!sameOrigin(source.url, into.url)) return null;
	if (into.database === source.database) {
		throw new ForkError(`fork: source and target are the same bql.sh database (${into.database})`);
	}
	const probe = await admin(source, `/v1/db/${into.database}`, { method: 'GET' });
	if (probe.ok || probe.status === 401 || probe.status === 403) {
		await probe.body?.cancel();
		return null;
	}
	if (probe.status !== 404) {
		throw new Error(
			`bql.sh: could not check whether ${into.database} exists (${probe.status} ${await probe.text()})`,
		);
	}
	const forked = await admin(source, '/v1/db', {
		method: 'POST',
		body: JSON.stringify({ name: into.database, from: { db: source.database } }),
	});
	// 409: created between the probe and here, by someone else. Theirs, so copy rather than claim it.
	if (forked.status === 401 || forked.status === 403 || forked.status === 409) {
		await forked.body?.cancel();
		return null;
	}
	if (!forked.ok) {
		throw new Error(
			`bql.sh: could not fork ${source.database} into ${into.database} (${forked.status} ${await forked.text()})`,
		);
	}
	// `POST /v1/db` answers with the new database's stats, settings included.
	const inherited = ((await forked.json()) as { foreignKeys?: boolean | null }).foreignKeys;
	const branch: NativeBranch = {
		discard: async () => {
			const dropped = await admin(source, `/v1/db/${into.database}`, { method: 'DELETE' });
			if (!dropped.ok && dropped.status !== 404) {
				throw new Error(
					`bql.sh: could not delete the branch ${into.database} (${dropped.status} ${await dropped.text()})`,
				);
			}
			await dropped.body?.cancel();
			remote.provisioned(false);
		},
	};
	// A branch inherits its parent's foreign-key setting. The target client's own setting decides,
	// as for a database `ensureDatabase` creates, so state it only when the two differ — the PATCH
	// closes and reopens the database. A branch that cannot be configured is discarded.
	if (into.foreignKeys !== false && inherited !== true) {
		const configured = await admin(source, `/v1/db/${into.database}`, {
			method: 'PATCH',
			body: JSON.stringify({ foreignKeys: true }),
		});
		if (!configured.ok) {
			const reason = `${configured.status} ${await configured.text()}`;
			await branch.discard();
			throw new Error(
				`bql.sh: forked ${into.database} but could not turn foreign keys on (${reason})`,
			);
		}
		await configured.body?.cancel();
	}
	remote.provisioned(true);
	return branch;
}

async function admin(opts: BqlRemoteOptions, path: string, init: RequestInit): Promise<Response> {
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
async function ensureDatabase(opts: BqlRemoteOptions): Promise<void> {
	const created = await admin(opts, '/v1/db', {
		method: 'POST',
		body: JSON.stringify({ name: opts.database }),
	});
	if (!created.ok && created.status !== 409) {
		throw new Error(
			`bql.sh: could not create the database ${opts.database} (${created.status} ${await created.text()}). Creating one is an admin route — pass an admin key as authToken/adminToken, or provision namespaces yourself and pass ensureDatabase: false.`,
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
			`bql.sh: could not turn foreign keys on for ${opts.database} (${configured.status} ${await configured.text()}). graphx's schema declares them; set the node's [sqlite] foreignKeys instead, or pass foreignKeys: false to accept unenforced references.`,
		);
	}
}

/**
 * The `driver: 'bql'` factory behind {@link import('./db.ts').getDb} — a server URL from
 * `bqlUrl` (or `GRAPHX_BQL_URL`) and a token from `authToken` (or `GRAPHX_BQL_TOKEN`),
 * with the namespace as the bql.sh database name.
 */
export function bqlDriver(namespace: string, cfg: DbConfig): DbClient {
	const url = cfg.bqlUrl ?? process.env.GRAPHX_BQL_URL;
	if (!url) {
		throw new Error(
			"getDb: the bql driver needs a server URL — pass { bqlUrl } or set GRAPHX_BQL_URL (e.g. 'http://127.0.0.1:4321')",
		);
	}
	return createBqlRemoteClient({
		url,
		database: namespace,
		authToken: cfg.authToken ?? process.env.GRAPHX_BQL_TOKEN,
		adminToken: process.env.GRAPHX_BQL_ADMIN_TOKEN,
	});
}

// Registered on import, exactly as `pg.ts` and `duck.ts` register theirs — so `getDb` can serve
// `driver: 'bql'` for a consumer who imported this subpath, and nobody else pays for it.
registerBqlDriver(bqlDriver);
