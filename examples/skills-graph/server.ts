/**
 * Dev API for the skills example — serves the graph built from `skill-collector`'s SQLite
 * database to `graphx-admin`.
 *
 *   bun run server.ts            # :8789, then: bun run dev:skills from the repo root
 *
 * Shaped like `scripts/admin-api.ts` rather than the one-liner dev `createApp`, because the admin
 * UI needs the operator registry (`/admin/tenants`) as well as the tenant-scoped graph routes.
 * Auth is a single dev bearer token (`ADMIN_TOKEN`, default "dev"). NOT for production — the
 * control plane is `:memory:` and the project DB is a local file.
 *
 * The first build is slow and large: 2.7M career transitions are loaded as 2.7M individual
 * temporal edges, so expect several minutes and a multi-GB database. It is cached afterwards.
 *
 *   COLLECTOR_DB=../../../skill-collector/skills_graph.db   source database
 *   FRESH=1                                                 force a rebuild
 *   EMBED_CAP=5000                                          embedded nodes, 0 for all
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { Database } from 'bun:sqlite';
import { createClient } from '@libsql/client';
import type { Context } from 'hono';
import {
	addMembership,
	bulkEdges,
	bulkLoad,
	createAdminApp,
	createApp,
	createProject,
	createTenant,
	createUser,
	getDb,
	graphForProject,
	hashEmbed,
	init,
	initControl,
	type Principal,
} from 'graphx-core';
import { buildNodes, streamEdges } from './load.ts';
import { SKILLS_SCHEMA_VERSION, skillsSchema } from './schema.ts';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev';
const PORT = Number(process.env.PORT ?? 8789);
const COLLECTOR_DB = process.env.COLLECTOR_DB ?? '../../../skill-collector/skills_graph.db';
const EMBED_CAP = Number(process.env.EMBED_CAP ?? 5_000);

const NAMESPACE = 'skills_demo';
const CACHE_FILE = '.seed-cache.json';

/**
 * Dev embedder: deterministic, model-free, no API key or network. Lexical rather than semantic,
 * so `/retrieve` and `/hybrid` return sensible neighbors for demo queries with no setup. 128 dims
 * rather than the 768 default — building the vector index is a superlinear cost in row count and
 * its width multiplies both time and disk.
 */
const DIM = 128;
const embed = hashEmbed(DIM);

if (!existsSync(COLLECTOR_DB)) {
	console.error(
		`[skills] no collector database at ${COLLECTOR_DB}\n` +
			'  Clone https://github.com/TimMikeladze/skill-collector next to this repo and run\n' +
			'  `bun run ingest` in it, or point COLLECTOR_DB at an existing skills_graph.db.',
	);
	process.exit(1);
}

// --- rebuild or reuse -------------------------------------------------------------------------
// The build is minutes long, which is fine once and intolerable on every start. Fingerprint what
// shaped the data and skip the work when it matches.

interface Cache {
	fingerprint: string;
}

const source = statSync(COLLECTOR_DB);
const fingerprint = JSON.stringify({
	schemaVersion: SKILLS_SCHEMA_VERSION,
	// The embedding width is baked into the vector column at first init and is immutable, so a
	// database built at another width must not be reused — it would fail on start, not degrade.
	dim: DIM,
	embedCap: EMBED_CAP,
	collector: { size: source.size, mtime: source.mtimeMs },
});

function cached(): boolean {
	if (!existsSync(CACHE_FILE) || !existsSync(`${NAMESPACE}.db`)) return false;
	try {
		return (JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Cache).fingerprint === fingerprint;
	} catch {
		return false;
	}
}

const rebuild = process.env.FRESH === '1' || !cached();
if (rebuild) {
	for (const suffix of ['', '-wal', '-shm']) rmSync(`${NAMESPACE}.db${suffix}`, { force: true });
	rmSync(CACHE_FILE, { force: true });
}

// --- control plane (always fresh; it is :memory:) ------------------------------------------------

const control = createClient({ url: ':memory:' });
await initControl(control);
const tenantId = await createTenant(control, { name: 'Labour Market' });
const userId = await createUser(control, { email: 'analyst@labour.test' });
await addMembership(control, { userId, tenantId, role: 'owner' });
const projectId = await createProject(control, {
	tenantId,
	name: 'Skills',
	dbNamespace: NAMESPACE,
});

// Create the vector column at the embedder's width BEFORE the lazy init inside graphForProject
// bakes the 768 default. `init` is idempotent, so the later re-init is a no-op.
await init(getDb(NAMESPACE), DIM);

// --- build -----------------------------------------------------------------------------------

const started = Date.now();
let summary: string;

if (rebuild) {
	const collector = new Database(COLLECTOR_DB, { readonly: true });
	const plan = buildNodes(collector);
	console.log(`[skills] loading ${plan.nodes.length} nodes from ${COLLECTOR_DB}`);

	// Embedding is a dominant cost: the vector index grows superlinearly in row count, so above the
	// cap semantic search sees a representative sample rather than every node. The sample is an
	// even stride over the load order, which runs sources, occupations, codes, then skills.
	const stride =
		EMBED_CAP > 0 && plan.nodes.length > EMBED_CAP ? Math.ceil(plan.nodes.length / EMBED_CAP) : 1;
	const rows = await Promise.all(
		plan.nodes.map(async (node, i) =>
			i % stride === 0 && node.body ? { ...node, emb: await embed(node.body) } : node,
		),
	);
	const embedded = rows.filter((r) => r.emb !== undefined).length;

	const graph = await graphForProject(
		control,
		{ userId: 'seed', tenantId, operator: true } satisfies Principal,
		projectId,
		'write',
		skillsSchema,
	);
	await bulkLoad(graph.raw, skillsSchema, rows, { chunkSize: 200 });

	console.log('[skills] loading edges — 2.7M career transitions, this takes a few minutes');
	let written = 0;
	const { edges, skipped } = await streamEdges(collector, plan, async (batch) => {
		await bulkEdges(graph.raw, skillsSchema, batch, { chunkSize: 200, types: plan.types });
		written += batch.length;
		if (written % 200_000 === 0) {
			console.log(`[skills]   ${(written / 1000).toFixed(0)}k edges`);
		}
	});
	collector.close();

	writeFileSync(CACHE_FILE, `${JSON.stringify({ fingerprint } satisfies Cache, null, 2)}\n`);
	summary =
		`${plan.nodes.length} nodes, ${edges} edges, ${embedded} embedded ` +
		`— built in ${((Date.now() - started) / 1000).toFixed(0)}s`;
	for (const [reason, count] of Object.entries({ ...plan.skipped, ...skipped }).sort(
		(a, b) => b[1] - a[1],
	)) {
		console.log(`[skills] skipped ${count} × ${reason}`);
	}
} else {
	summary = 'reused the cached database (FRESH=1 to rebuild)';
}

// --- serve -----------------------------------------------------------------------------------

function bearer(c: Context): string | undefined {
	const header = c.req.header('authorization') ?? '';
	return header.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/** Tenant-scoped authn: the dev token ⇒ an operator principal scoped to the route's tenant. */
function authenticate(c: Context): Principal {
	if (bearer(c) !== ADMIN_TOKEN) throw new Error('unauthorized');
	return { userId: 'operator', tenantId: c.req.param('tenant') as string, operator: true };
}

/** Operator authn for `/admin/*`: the same dev token. */
function adminAuthenticate(c: Context): void {
	if (bearer(c) !== ADMIN_TOKEN) throw new Error('unauthorized');
}

/**
 * A much lower row cap than the 10,000 default, because this graph is dense in a way the default
 * does not anticipate: `graphSlice` caps the *nodes* it returns but then fetches every edge among
 * them, and 2.7M transitions over 4,260 codes means 5,000 nodes drag 2.1M edges (a 400MB response
 * that no browser will render). At 1,000 the unfiltered view is small and the `occupation_code`
 * view is ~95k edges — dense, but WebGL handles it.
 */
const app = createApp({
	control,
	schema: skillsSchema,
	authenticate,
	embed,
	cors: true,
	limits: { maxRows: 1_000 },
});
app.route('/admin', createAdminApp({ control, authenticate: adminAuthenticate }));

Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[skills] http://localhost:${PORT}  token="${ADMIN_TOKEN}"  ${summary}`);
