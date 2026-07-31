/**
 * Dev API for the pantheon example — serves the graph built from `pantheon-collector`'s SQLite
 * database to `@graphx/admin`.
 *
 *   bun run server.ts            # :8788, then: bun run admin  (Vite on :5173, proxied here)
 *
 * Shaped like `scripts/admin-api.ts` rather than the one-liner dev `createApp`, because the admin
 * UI needs the operator registry (`/admin/tenants`) as well as the tenant-scoped graph routes.
 * Auth is a single dev bearer token (`ADMIN_TOKEN`, default "dev"). NOT for production — the
 * control plane is `:memory:` and the project DB is a local file.
 *
 *   COLLECTOR_DB=../../../pantheon-collector/pantheon_graph.db   source database
 *   FRESH=1                                                      force a rebuild
 *   EMBED_CAP=5000                                               embedded nodes, 0 for all
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import process from 'node:process';
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
} from '@graphx/core';
import { loadPantheon } from './load.ts';
import { PANTHEON_SCHEMA_VERSION, pantheonSchema } from './schema.ts';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev';
const PORT = Number(process.env.PORT ?? 8788);
const COLLECTOR_DB = process.env.COLLECTOR_DB ?? '../../../pantheon-collector/pantheon_graph.db';
const EMBED_CAP = Number(process.env.EMBED_CAP ?? 5_000);

const NAMESPACE = 'pantheon_demo';
const CACHE_FILE = '.seed-cache.json';

/**
 * Dev embedder: deterministic, model-free, no API key or network. Lexical rather than semantic,
 * so `/retrieve` and `/hybrid` return sensible neighbors for demo queries with no setup. 128 dims
 * rather than the 768 default — building the vector index is the load's slowest step and its
 * cost scales with width.
 */
const DIM = 128;
const embed = hashEmbed(DIM);

if (!existsSync(COLLECTOR_DB)) {
	console.error(
		`[pantheon] no collector database at ${COLLECTOR_DB}\n` +
			'  Clone https://github.com/TimMikeladze/pantheon-collector next to this repo and run\n' +
			'  `bun run ingest` in it, or point COLLECTOR_DB at an existing pantheon_graph.db.',
	);
	process.exit(1);
}

// --- rebuild or reuse -------------------------------------------------------------------------
// Loading ~10k nodes and building their vector index takes tens of seconds, which is fine once
// and tedious on every start. Fingerprint what shaped the data and skip the work when it matches.

interface Cache {
	fingerprint: string;
}

const source = statSync(COLLECTOR_DB);
const fingerprint = JSON.stringify({
	schemaVersion: PANTHEON_SCHEMA_VERSION,
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
const tenantId = await createTenant(control, { name: 'Mythology' });
const userId = await createUser(control, { email: 'curator@mythology.test' });
await addMembership(control, { userId, tenantId, role: 'owner' });
const projectId = await createProject(control, {
	tenantId,
	name: 'Pantheon',
	dbNamespace: NAMESPACE,
});

// Create the vector column at the embedder's width BEFORE the lazy init inside graphForProject
// bakes the 768 default. `init` is idempotent, so the later re-init is a no-op.
await init(getDb(NAMESPACE), DIM);

// --- build -----------------------------------------------------------------------------------

const started = Date.now();
let summary: string;

if (rebuild) {
	const plan = loadPantheon(COLLECTOR_DB);
	console.log(
		`[pantheon] loading ${plan.nodes.length} nodes and ${plan.edges.length} edges from ${COLLECTOR_DB}`,
	);

	// Embedding is the dominant cost: the vector index grows superlinearly in row count, so above
	// the cap semantic search sees a representative sample rather than every node. The sample is
	// an even stride over the load order, which interleaves sources, pantheons, deities, domains.
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
		pantheonSchema,
	);
	await bulkLoad(graph.raw, pantheonSchema, rows, { chunkSize: 200 });
	// One `bulkEdges` call is one batch, so slice to bound peak statement size.
	const SLICE = 10_000;
	for (let i = 0; i < plan.edges.length; i += SLICE) {
		await bulkEdges(graph.raw, pantheonSchema, plan.edges.slice(i, i + SLICE), {
			chunkSize: 200,
			types: plan.types,
		});
	}

	writeFileSync(CACHE_FILE, `${JSON.stringify({ fingerprint } satisfies Cache, null, 2)}\n`);
	summary =
		`${plan.nodes.length} nodes, ${plan.edges.length} edges, ${embedded} embedded ` +
		`— built in ${((Date.now() - started) / 1000).toFixed(1)}s`;
	for (const [reason, count] of Object.entries(plan.skipped).sort((a, b) => b[1] - a[1])) {
		console.log(`[pantheon] skipped ${count} × ${reason}`);
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

const app = createApp({ control, schema: pantheonSchema, authenticate, embed, cors: true });
app.route('/admin', createAdminApp({ control, authenticate: adminAuthenticate }));

Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[pantheon] http://localhost:${PORT}  token="${ADMIN_TOKEN}"  ${summary}`);
