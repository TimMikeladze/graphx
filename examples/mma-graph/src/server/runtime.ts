/**
 * The per-process graphx server behind the whole Next.js app.
 *
 * Boot (once per server process, awaited by every page and route handler):
 *
 * 1. fingerprint the inputs (scrape-state mtime + newest vault folder mtime + schema version +
 *    embedder id) — a changed vault rebuilds automatically, `FRESH=1` forces it;
 * 2. on rebuild, drop the cached db handle + files, then boot graphx's dev-mode `createApp`
 *    (in-memory control plane, one tenant/project, header auth — NOT for production) whose
 *    `seed` hook ingests the vault and runs the derived-stats pass;
 * 3. route `createAdminApp` under /admin and return `{ app, graph }`.
 *
 * The returned Hono `app` is served verbatim by the `app/[...gx]` catch-all route (graphx's
 * generated `/t/…` routes, `/openapi.json`, `/docs`); the domain queries in `queries.ts` read
 * the same `graph` handle directly.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createAdminApp, createApp, evict, hashEmbed } from 'graphx';
import { ingestVault } from '../load.ts';
import { MMA_SCHEMA_VERSION, mmaSchema } from '../schema.ts';

const NAMESPACE = 'mma_demo';
const ROOT = process.cwd();
// The vault is 100k+ scraped files that exist only at runtime — Turbopack's fs tracer must
// not fold these paths into build-time file dependencies (hence the turbopackIgnore comments).
const VAULT_DIR = join(/*turbopackIgnore: true*/ ROOT, 'vault');
const STATE_PATH = join(ROOT, '.scrape-state.json');
const CACHE_FILE = join(ROOT, '.seed-cache.json');
const PORT = Number(process.env.PORT ?? 8793);

/** The embedder: deterministic, no key, 128 dims (vector index cost scales with width). */
const embedder = hashEmbed(128);

/** graphx's dev-mode serving app for the MMA schema (in-memory control plane, one project). */
function createMmaApp() {
	return createApp({
		schema: mmaSchema,
		embedder,
		cors: true,
		db: NAMESPACE,
		limits: { maxRows: 5_000 },
		openapi: { title: 'mma-graph', servers: [{ url: `http://localhost:${PORT}` }] },
	});
}

type MmaApp = Awaited<ReturnType<typeof createMmaApp>>['app'];
type MmaGraph = Awaited<ReturnType<typeof createMmaApp>>['graph'];

export interface MmaServer {
	/** The graphx-generated HTTP app — `/t/…`, `/openapi.json`, `/docs`, `/admin/…`. */
	app: MmaApp;
	/** The same graph handle the generated routes serve — read directly by the domain queries. */
	graph: MmaGraph;
	tenant: string;
	project: string;
	/** What the boot did (ingest counts, or "reused the cached database"). */
	summary: string;
}

/**
 * Await the shared server — first call boots it, every later call reuses the same promise.
 *
 * The cache lives on `globalThis` because Next.js dev gives each route entry its own module
 * registry: a plain module-level variable would be per-route, and simultaneous first requests
 * would start one ingest PER route. On the global it is one per process, dev and prod alike.
 */
export function mma(): Promise<MmaServer> {
	const g = globalThis as { __mmaBoot?: Promise<MmaServer> };
	return (g.__mmaBoot ??= bootServer());
}

// --- rebuild or reuse: fingerprint the inputs ------------------------------------------------------

interface Cache {
	fingerprint: string;
}

function vaultFingerprint(): string {
	// The scrape state records id assignments + known titles; together with the newest mtime
	// across vault folders it changes whenever the vault changes.
	const state = existsSync(STATE_PATH) ? statSync(STATE_PATH).mtimeMs : 0;
	let newest = 0;
	for (const dir of ['fighter', 'fight', 'event']) {
		try {
			const s = statSync(join(/*turbopackIgnore: true*/ VAULT_DIR, dir));
			newest = Math.max(newest, s.mtimeMs);
		} catch {
			/* folder absent — an empty vault section */
		}
	}
	return `${state}:${newest}`;
}

const fingerprint = JSON.stringify({
	schemaVersion: MMA_SCHEMA_VERSION,
	embedder: embedder.id,
	vault: vaultFingerprint(),
});

function cached(): boolean {
	if (!existsSync(CACHE_FILE) || !existsSync(join(ROOT, `${NAMESPACE}.db`))) return false;
	try {
		return (JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Cache).fingerprint === fingerprint;
	} catch {
		return false;
	}
}

// --- boot ---------------------------------------------------------------------------------------------

async function bootServer(): Promise<MmaServer> {
	if (!existsSync(/*turbopackIgnore: true*/ VAULT_DIR)) {
		throw new Error(
			`no vault at ${VAULT_DIR} — run \`bun scrape.ts full\` first (or \`--limit 25\` for a quick slice)`,
		);
	}

	const rebuild = process.env.FRESH === '1' || !cached();
	if (rebuild) {
		evict(NAMESPACE); // drop any cached handle before deleting the files under it
		for (const suffix of ['', '-wal', '-shm'])
			rmSync(join(ROOT, `${NAMESPACE}.db${suffix}`), { force: true });
		rmSync(CACHE_FILE, { force: true });
	}

	// The seed hook's return value is ignored by createApp, so the ingest summary travels out
	// through this closure — set during boot, read immediately after.
	let ingested: Awaited<ReturnType<typeof ingestVault>> | undefined;

	const started = Date.now();
	const { app, control, graph, tenant, project } = await createMmaApp();
	if (rebuild) {
		ingested = await ingestVault(graph, VAULT_DIR);
	}
	app.route('/admin', createAdminApp({ control, authenticate: () => {} }));

	let summary: string;
	if (ingested) {
		writeFileSync(CACHE_FILE, `${JSON.stringify({ fingerprint } satisfies Cache)}\n`);
		const { result, derived } = ingested;
		const skipCodes = new Map<string, number>();
		for (const s of result.skipped)
			skipCodes.set(`${s.stage}:${s.code}`, (skipCodes.get(`${s.stage}:${s.code}`) ?? 0) + 1);
		summary =
			`${result.added} nodes / ${result.edgesAdded} edges ingested, ${derived.updated} fighters derived ` +
			`— built in ${((Date.now() - started) / 1000).toFixed(0)}s` +
			(skipCodes.size > 0
				? `; skipped: ${[...skipCodes].map(([c, n]) => `${n}×${c}`).join(', ')}`
				: '');
	} else {
		summary = 'reused the cached database (FRESH=1 to rebuild)';
	}
	console.log(`[mma] ${summary}`);

	return { app, graph, tenant, project, summary };
}
