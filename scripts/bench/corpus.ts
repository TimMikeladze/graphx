/**
 * The graph the benchmarks run against, and the cache that keeps it from being rebuilt.
 *
 * Nothing here generates data: `scripts/seed/` already produces a deterministic graph with skewed
 * degree, communities, and a temporal spread, which is a far better benchmark corpus than a
 * uniform random one — hub nodes are where fan-out guards and walk blowups actually show up.
 * This module sizes that generator, loads it, caches the result, and hands suites a context.
 *
 * **Time is fixed, not `Date.now()`.** The corpus is cached across runs, so its temporal window
 * has to be reproducible: a corpus generated relative to wall-clock time would have a different
 * as-of window every day while keeping the same cache key. {@link BENCH_NOW} is that fixed point.
 *
 * **The embedded-node cap does not scale with the graph.** `applyPlan`'s own measurements put
 * libSQL vector-index construction at ~6s for 2k vectors, ~16s for 5k, ~36s for 10k and ~108s for
 * 25k, against about a second for everything else combined — it is superlinear and it dominates.
 * Letting it track node count would make the 100k corpus impractical and would smear one
 * component's cost across every suite. So the cap is held at {@link MAX_EMBEDDED} for all scales,
 * the retrieval suite measures seeding/fusion/walk against a growing graph with a fixed-size
 * vector index, and the `ann` suite varies vector count on its own axis.
 *
 * The consequence is worth stating plainly: at 100k nodes semantic search sees a 5k-node sample.
 * Timings from this harness are meaningful; recall numbers from it are not. Recall is the job of
 * the quality harness in `packages/graphx/test/core/eval-*`.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { createClient } from '@libsql/client';
import type { DbClient, EmbedFn } from '../../packages/graphx/src/core/index.ts';
import { Graph, hashEmbed, init } from '../../packages/graphx/src/core/index.ts';
import { createPgClient } from '../../packages/graphx/src/core/pg.ts';
import { applyPlan } from '../seed/apply.ts';
import { generate } from '../seed/generate.ts';
import { DEMO_SCHEMA_VERSION, type DemoSchema, demoSchema } from '../seed/schema.ts';
import { withHistory } from '../seed/temporal.ts';

export type Scale = '1k' | '10k' | '100k';

/** The scale ladder. Three points separate linear from log from quadratic; more is diminishing. */
export const SCALES: Record<Scale, number> = {
	'1k': 1_000,
	'10k': 10_000,
	'100k': 100_000,
};

export const ALL_SCALES: Scale[] = ['1k', '10k', '100k'];

export function isScale(value: string): value is Scale {
	return value in SCALES;
}

/**
 * Embedding width. 128 rather than the 768 default, matching `scripts/admin-api.ts`: width drives
 * both index build time and disk footprint, and the generated corpus has a vocabulary of a few
 * hundred words, so 128 hash buckets still separate it.
 */
export const DIM = 128;

/** Generator seed. Fixed, so the same scale always yields the same graph. */
export const SEED = 7;

/** See the module note — held constant across the whole ladder on purpose. */
export const MAX_EMBEDDED = 5_000;

/** The corpus's "now". Fixed so a cached corpus keeps the temporal window it was built with. */
export const BENCH_NOW = Date.UTC(2026, 6, 27);

/** How far back node creation times spread from {@link BENCH_NOW}. */
export const WINDOW_DAYS = 90;

export const DAY_MS = 86_400_000;

export const embed: EmbedFn = hashEmbed(DIM);

/** Selected backend, mirroring `GRAPHX_TEST_DRIVER` in the test harness. */
export const DRIVER = process.env.GRAPHX_BENCH_DRIVER ?? 'libsql';

const PG_URL =
	process.env.GRAPHX_BENCH_PG_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5455/graphx_test';

/**
 * Overridable so two checkouts of the repo — a PR head and its base, say — can share one corpus
 * cache. Sharing is safe by construction: the fingerprint covers everything that shapes the data,
 * so two checkouts whose generators differ simply get two files.
 */
const CORPUS_DIR = process.env.GRAPHX_BENCH_CORPUS_DIR
	? resolve(process.env.GRAPHX_BENCH_CORPUS_DIR)
	: resolve(import.meta.dirname, '../../bench/.corpus');

/** Everything that changes the generated data. Any difference is a different corpus. */
export interface CorpusKey {
	schemaVersion: number;
	seed: number;
	dim: number;
	embedded: number;
	nodes: number;
	now: number;
	windowDays: number;
}

export function corpusKey(scale: Scale, embedded: number = MAX_EMBEDDED): CorpusKey {
	return {
		schemaVersion: DEMO_SCHEMA_VERSION,
		seed: SEED,
		dim: DIM,
		embedded,
		nodes: SCALES[scale],
		now: BENCH_NOW,
		windowDays: WINDOW_DAYS,
	};
}

/**
 * The cache key, carried in the corpus's filename (libSQL) or schema name (Postgres). Putting the
 * fingerprint in the name rather than a sidecar file means a stale corpus is never *found*, so
 * there is no invalidation step to get wrong.
 */
export function corpusFingerprint(key: CorpusKey): string {
	return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16);
}

export interface CorpusStats {
	/** Distinct live node identities. */
	nodes: number;
	/** Node version rows — identities plus their superseded revisions. */
	versions: number;
	edges: number;
	/** Live nodes carrying a vector; the reachable set for semantic search. */
	embedded: number;
}

export interface Corpus {
	client: DbClient;
	graph: Graph<DemoSchema>;
	scale: Scale;
	key: CorpusKey;
	stats: CorpusStats;
	/** Live node ids, evenly sampled — cases index into this to vary their inputs. */
	nodeIds: string[];
	/** Query strings drawn from node bodies, so they hit the corpus's real vocabulary. */
	queries: string[];
	close: () => Promise<void>;
}

// --- generation --------------------------------------------------------------------------------

/** Generate and load one corpus into an already-`init`ed client. */
async function seedInto(client: DbClient, key: CorpusKey): Promise<void> {
	const plan = withHistory(
		generate({ nodes: key.nodes, seed: key.seed, now: key.now, windowDays: key.windowDays }),
		{ seed: key.seed + 1000, now: key.now },
	);
	await applyPlan(client, plan, hashEmbed(key.dim), { maxEmbedded: key.embedded });
}

async function countStats(client: DbClient): Promise<CorpusStats> {
	const one = async (sql: string): Promise<number> =>
		Number((await client.execute(sql)).rows[0]?.c ?? 0);
	return {
		nodes: await one('SELECT COUNT(*) AS c FROM nodes'),
		versions: await one('SELECT COUNT(*) AS c FROM node_versions'),
		edges: await one('SELECT COUNT(*) AS c FROM edges'),
		embedded: await one('SELECT COUNT(*) AS c FROM nodes WHERE emb IS NOT NULL'),
	};
}

// --- libSQL ------------------------------------------------------------------------------------

function libsqlPath(key: CorpusKey, scale: Scale): string {
	return `${CORPUS_DIR}/${corpusFingerprint(key)}-${scale}.db`;
}

function removeDb(path: string): void {
	for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

/**
 * Build the cached corpus file if it is not already there. Seeding happens against a `.building`
 * path and is renamed into place only on success, so a run interrupted mid-seed leaves no
 * half-written database that the next run would happily treat as cached.
 */
async function ensureLibsqlCorpus(key: CorpusKey, scale: Scale, log: Logger): Promise<string> {
	mkdirSync(CORPUS_DIR, { recursive: true });
	const path = libsqlPath(key, scale);
	if (existsSync(path)) return path;

	const building = `${path}.building`;
	removeDb(building);
	log(
		`seeding ${scale} corpus (${SCALES[scale].toLocaleString()} nodes, ${key.embedded.toLocaleString()} vectors) — later runs reuse it`,
	);
	const client = createClient({ url: `file:${building}` });
	await init(client, key.dim);
	await seedInto(client, key);
	// Fold the WAL back into the main file so the cached corpus is a single copyable artifact.
	await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
	client.close();
	renameSync(building, path);
	removeDb(building);
	return path;
}

// --- Postgres ----------------------------------------------------------------------------------

function pgSchema(key: CorpusKey, scale: Scale): string {
	return `bench_${corpusFingerprint(key)}_${scale.replace(/\W/g, '')}`;
}

async function pgSchemaHasCorpus(schema: string, expected: number): Promise<boolean> {
	const admin = createPgClient({ connectionString: PG_URL });
	try {
		const exists = await admin.execute({
			sql: `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = ? AND table_name = 'nodes'`,
			args: [schema],
		});
		if (exists.rows.length === 0) return false;
		const count = await admin.execute(`SELECT COUNT(*) AS c FROM "${schema}".nodes`);
		return Number(count.rows[0]?.c ?? 0) === expected;
	} catch {
		return false;
	} finally {
		await admin.end();
	}
}

async function dropPgSchema(schema: string): Promise<void> {
	const admin = createPgClient({ connectionString: PG_URL });
	try {
		await admin.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
	} finally {
		await admin.end();
	}
}

async function openPgCorpus(
	key: CorpusKey,
	scale: Scale,
	schema: string,
	log: Logger,
): Promise<DbClient> {
	const client = createPgClient({
		connectionString: PG_URL,
		schema,
		ensureSchema: true,
		ensureExtension: true,
	});
	await init(client, key.dim);
	const rows = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	if (Number(rows.rows[0]?.c ?? 0) !== key.nodes) {
		log(`seeding ${scale} corpus into schema ${schema} — later runs reuse it`);
		await seedInto(client, key);
	}
	return client;
}

// --- public API --------------------------------------------------------------------------------

export type Logger = (message: string) => void;

const SILENT: Logger = () => {};

/** Even stride over an ordered list — a spread sample, not a prefix. */
function stride<T>(items: T[], count: number): T[] {
	if (items.length <= count) return items;
	const step = items.length / count;
	return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)] as T);
}

/**
 * Query strings drawn from the corpus itself. A hand-written query list would drift from whatever
 * the generator's vocabulary happens to be; taking three-word phrases out of real bodies keeps
 * both the ANN and the FTS leg on terms that actually exist.
 */
function queriesFrom(bodies: string[]): string[] {
	const out: string[] = [];
	for (const body of bodies) {
		const words = body
			.toLowerCase()
			.split(/\W+/)
			.filter((w) => w.length > 3);
		if (words.length >= 3) out.push(words.slice(0, 3).join(' '));
	}
	return out.length > 0 ? out : ['platform'];
}

async function buildCorpus(client: DbClient, scale: Scale, key: CorpusKey): Promise<Corpus> {
	const stats = await countStats(client);
	// One pass over a bounded prefix, then strided down — cheap at every scale, and deterministic
	// because `nodes` is ordered by the ULID primary key.
	const sample = await client.execute('SELECT id, body FROM nodes ORDER BY id LIMIT 4000');
	const rows = sample.rows as unknown as Array<{ id: string; body: string | null }>;
	const nodeIds = stride(
		rows.map((r) => String(r.id)),
		500,
	);
	const queries = stride(queriesFrom(rows.map((r) => r.body ?? '').filter(Boolean)), 100);
	return {
		client,
		graph: new Graph(client, demoSchema),
		scale,
		key,
		stats,
		nodeIds,
		queries,
		close: async () => {
			await closeClient(client);
		},
	};
}

async function closeClient(client: DbClient): Promise<void> {
	const maybePg = client as DbClient & { end?: () => Promise<void> };
	if (typeof maybePg.end === 'function') await maybePg.end();
	else client.close();
}

/**
 * The shared, read-only corpus at `scale`. Built once and cached on disk (or in a Postgres
 * schema); every read-only suite in a run gets the same one.
 */
export async function openCorpus(
	scale: Scale,
	opts: { embedded?: number; log?: Logger } = {},
): Promise<Corpus> {
	const key = corpusKey(scale, opts.embedded);
	const log = opts.log ?? SILENT;
	if (DRIVER === 'postgres') {
		const schema = pgSchema(key, scale);
		return buildCorpus(await openPgCorpus(key, scale, schema, log), scale, key);
	}
	const path = await ensureLibsqlCorpus(key, scale, log);
	return buildCorpus(createClient({ url: `file:${path}` }), scale, key);
}

/**
 * A private, writable copy of the corpus for a case that mutates. Each mutating case takes a
 * fresh one so its measurements start from identical state.
 *
 * On libSQL that is a file copy of the cached corpus: cheap and exact. On Postgres there is no
 * equivalent — the schema is re-seeded, which is slow, and only the opt-in Postgres path pays it.
 */
export async function freshCorpus(
	scale: Scale,
	opts: { embedded?: number; log?: Logger } = {},
): Promise<Corpus> {
	const key = corpusKey(scale, opts.embedded);
	const log = opts.log ?? SILENT;
	if (DRIVER === 'postgres') {
		const schema = `${pgSchema(key, scale)}_scratch`;
		log(`re-seeding ${scale} scratch schema (Postgres has no copy-restore) — this is slow`);
		await dropPgSchema(schema);
		const client = createPgClient({
			connectionString: PG_URL,
			schema,
			ensureSchema: true,
			ensureExtension: true,
		});
		await init(client, key.dim);
		await seedInto(client, key);
		const corpus = await buildCorpus(client, scale, key);
		return {
			...corpus,
			close: async () => {
				await closeClient(client);
				await dropPgSchema(schema);
			},
		};
	}
	const path = await ensureLibsqlCorpus(key, scale, log);
	const scratch = `${CORPUS_DIR}/scratch-${scale}.db`;
	removeDb(scratch);
	copyFileSync(path, scratch);
	const client = createClient({ url: `file:${scratch}` });
	const corpus = await buildCorpus(client, scale, key);
	return {
		...corpus,
		close: async () => {
			client.close();
			removeDb(scratch);
		},
	};
}

/** Delete every cached corpus, so the next run rebuilds from nothing. */
export function wipeCorpora(): void {
	rmSync(CORPUS_DIR, { recursive: true, force: true });
}

/** True when a corpus at this scale is already built (Postgres answers over the wire). */
export async function isCorpusCached(scale: Scale, embedded?: number): Promise<boolean> {
	const key = corpusKey(scale, embedded);
	if (DRIVER === 'postgres') return pgSchemaHasCorpus(pgSchema(key, scale), key.nodes);
	return existsSync(libsqlPath(key, scale));
}
