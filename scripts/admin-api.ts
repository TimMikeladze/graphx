/**
 * Development API for graphx-admin. Better Auth persists identities and organizations;
 * Graphx stores project metadata and demo graph databases under .graphx-data/admin.
 * Existing operator-mode databases are not migrated. Not a production server.
 *
 * The graph itself comes from `scripts/seed/` (deterministic generator + bulk load). Building it
 * costs seconds, so the databases are kept between runs and rebuilt only when the seed config
 * changes — see `scripts/seed/cache.ts`.
 *
 *   SEED_NODES=50000   size of the big project (default 25000)
 *   SEED_SEED=7        PRNG seed (default 7)
 *   SEED_EMBED=5000    cap on embedded nodes per project, 0 for all (default 5000)
 *   SEED_FRESH=1       force a rebuild
 */
import process from 'node:process';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@libsql/client';
import {
	createProject,
	graphForProject,
	hashEmbed,
	type Principal,
} from '../packages/graphx/src/core/index.ts';
import {
	createBetterAuthApp,
	initBetterAuthControl,
} from '../packages/graphx/src/better-auth/index.ts';
import { setupAdminAuth } from './admin-auth.ts';
import { applyPlan } from './seed/apply.ts';
import { fingerprint, isCached, wipe, writeCache } from './seed/cache.ts';
import { generate } from './seed/generate.ts';
import { DEMO_SCHEMA_VERSION, demoSchema } from './seed/schema.ts';
import { withHistory } from './seed/temporal.ts';

const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'graphx-development';
const DATA_DIR = resolve(
	process.env.ADMIN_DATA_DIR ?? resolve(import.meta.dir, '../.graphx-data/admin'),
);
mkdirSync(DATA_DIR, { recursive: true });
process.chdir(DATA_DIR);
const SEED_NODES = Number(process.env.SEED_NODES ?? 25_000);
const SEED_SEED = Number(process.env.SEED_SEED ?? 7);
const SEED_EMBED = Number(process.env.SEED_EMBED ?? 5_000);

/**
 * Dev embedder: deterministic, model-free, no API key or network. Lexical rather than semantic,
 * so /retrieve and /hybrid return sensible neighbors for demo queries without any setup.
 *
 * 128 dims rather than the 768 default. Width drives both the seed's slowest step and its disk
 * footprint, because the vector index stores neighbor lists of full vectors: measured at 5000
 * vectors, 256 dims costs ~16s and ~315MB against ~4s and ~111MB at 128. The generated corpus
 * has a vocabulary of a few hundred words, so 128 hash buckets still separate it well.
 */
const DIM = 128;
const embedder = hashEmbed(DIM);

/** The demo estate. Sizes differ so the explorer sees a truncated slice, small graphs and an empty one. */
const FIXTURES = [
	{ tenant: 'Acme', project: 'Platform', namespace: 'dev_admin_platform', nodes: SEED_NODES },
	{ tenant: 'Acme', project: 'Archive', namespace: 'dev_admin_archive', nodes: 2_000 },
	{ tenant: 'Globex', project: 'Research', namespace: 'dev_admin_research', nodes: 200 },
	{ tenant: 'Globex', project: 'Scratch', namespace: 'dev_admin_scratch', nodes: 40 },
	{ tenant: 'Initech', project: 'Empty', namespace: 'dev_admin_empty', nodes: 0 },
];

// --- decide whether to rebuild -------------------------------------------------------------

const namespaces = FIXTURES.map((f) => f.namespace);
const fp = fingerprint({
	schemaVersion: DEMO_SCHEMA_VERSION,
	seed: SEED_SEED,
	dim: DIM,
	embedded: SEED_EMBED,
	fixtures: FIXTURES.map((f) => ({ namespace: f.namespace, nodes: f.nodes })),
});
const rebuild = process.env.SEED_FRESH === '1' || !isCached(fp, namespaces);
if (rebuild) wipe(namespaces);

// --- persistent Better Auth identities and the Graphx project registry ----------------------

const identity = await setupAdminAuth({
	database: new Database('dev_admin_auth.db'),
	baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${PORT}`,
	email: ADMIN_EMAIL,
	password: ADMIN_PASSWORD,
	secret: process.env.BETTER_AUTH_SECRET,
	onInvitation: (email, url) => console.log(`[admin-api] invitation for ${email}: ${url}`),
});
const control = createClient({ url: 'file:dev_admin_registry.db' });
await initBetterAuthControl(control);

const tenants = new Map<string, string>();
for (const { tenant } of FIXTURES) {
	if (!tenants.has(tenant))
		tenants.set(tenant, await identity.ensureOrganization(tenant, tenant.toLowerCase()));
}

// --- build (or reuse) each project's graph ---------------------------------------------------

const now = Date.now();
const started = now;
const summary: string[] = [];

for (const [i, fixture] of FIXTURES.entries()) {
	const tenantId = tenants.get(fixture.tenant) as string;
	const existing = await control.execute({
		sql: 'SELECT id, tenant_id FROM projects WHERE db_namespace = ?',
		args: [fixture.namespace],
	});
	if (existing.rows[0] && String(existing.rows[0].tenant_id) !== tenantId)
		throw new Error(
			`Demo project ${fixture.namespace} belongs to another organization; use a fresh ADMIN_DATA_DIR`,
		);
	const projectId = existing.rows[0]
		? String(existing.rows[0].id)
		: await createProject(control, {
				tenantId,
				name: fixture.project,
				dbNamespace: fixture.namespace,
			});

	if (!rebuild) {
		summary.push(`${fixture.tenant}/${fixture.project}: cached`);
		continue;
	}

	const seedPrincipal: Principal = { userId: 'seed', tenantId, operator: true };
	const g = await graphForProject(control, seedPrincipal, projectId, 'write', demoSchema, {
		embedder,
	});
	// Each project gets its own PRNG stream, so they are different graphs rather than prefixes
	// of one graph.
	const plan = withHistory(generate({ nodes: fixture.nodes, seed: SEED_SEED + i, now }), {
		seed: SEED_SEED + 1000 + i,
		now,
	});
	// Building the vector index is the slow part, so say what is happening before starting.
	console.log(
		`[admin-api] building ${fixture.tenant}/${fixture.project} — ${plan.nodes.length} node rows, ${plan.edges.length} edges`,
	);
	const loaded = await applyPlan(g.raw, plan, embedder, { maxEmbedded: SEED_EMBED });
	summary.push(
		`${fixture.tenant}/${fixture.project}: ${loaded.nodes} nodes (${loaded.versions} versions), ${loaded.edges} edges, ${loaded.embedded} embedded`,
	);
}

if (rebuild) writeCache(fp, namespaces);

const app = await createBetterAuthApp({
	auth: identity.auth,
	control,
	schema: demoSchema,
	embedder,
	development: true,
	projectAccess: true,
});

Bun.serve({ port: PORT, fetch: app.fetch });
console.log(
	`[admin-api] http://localhost:${PORT}  account="${ADMIN_EMAIL}"  ${
		rebuild ? `built in ${((Date.now() - started) / 1000).toFixed(1)}s` : 'reused cached databases'
	}`,
);
for (const line of summary) console.log(`  ${line}`);
