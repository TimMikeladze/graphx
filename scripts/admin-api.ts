/**
 * Dev API server for @graphx/admin — seeds an in-memory control plane + a generated demo graph
 * across three tenants and five projects, mounts the tenant-scoped graph routes (createApp) and
 * the operator sub-app (createAdminApp), and serves on :8787. Auth is a single dev bearer token
 * (ADMIN_TOKEN, default "dev") that the operator presents; the `authenticate` impl turns it into
 * an operator principal so it can browse any tenant. NOT for production — the control plane is
 * :memory: and the project DBs are local files.
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
import { createClient } from '@libsql/client';
import {
	addMembership,
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
} from '../packages/core/src/index.ts';
import { applyPlan } from './seed/apply.ts';
import { fingerprint, isCached, wipe, writeCache } from './seed/cache.ts';
import { generate } from './seed/generate.ts';
import { DEMO_SCHEMA_VERSION, demoSchema } from './seed/schema.ts';
import { withHistory } from './seed/temporal.ts';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev';
const PORT = Number(process.env.PORT ?? 8787);
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
const embed = hashEmbed(DIM);

/** The demo estate. Sizes differ so the explorer sees a truncated slice, small graphs and an empty one. */
const FIXTURES = [
	{ tenant: 'Acme', project: 'Platform', namespace: 'dev_admin_platform', nodes: SEED_NODES },
	{ tenant: 'Acme', project: 'Archive', namespace: 'dev_admin_archive', nodes: 2_000 },
	{ tenant: 'Globex', project: 'Research', namespace: 'dev_admin_research', nodes: 200 },
	{ tenant: 'Globex', project: 'Scratch', namespace: 'dev_admin_scratch', nodes: 40 },
	{ tenant: 'Initech', project: 'Empty', namespace: 'dev_admin_empty', nodes: 0 },
];

function bearer(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
	const h = c.req.header('authorization') ?? '';
	return h.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/** Tenant-scoped authn: the dev token ⇒ an operator principal scoped to the route tenant. */
function authenticate(c: {
	req: { header: (n: string) => string | undefined; param: (n: string) => string };
}): Principal {
	if (bearer(c) !== ADMIN_TOKEN) throw new Error('unauthorized');
	return { userId: 'operator', tenantId: c.req.param('tenant'), operator: true };
}

/** Operator authn for /admin/*: same dev token. */
function adminAuthenticate(c: { req: { header: (n: string) => string | undefined } }): void {
	if (bearer(c) !== ADMIN_TOKEN) throw new Error('unauthorized');
}

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

// --- control plane (always fresh; it is :memory:) -------------------------------------------

const control = createClient({ url: ':memory:' });
await initControl(control);

const tenants = new Map<string, string>();
for (const { tenant } of FIXTURES) {
	if (!tenants.has(tenant)) tenants.set(tenant, await createTenant(control, { name: tenant }));
}
const ada = await createUser(control, { email: 'ada@acme.test' });
for (const tenantId of tenants.values()) {
	await addMembership(control, { userId: ada, tenantId, role: 'owner' });
}

// --- build (or reuse) each project's graph ---------------------------------------------------

const now = Date.now();
const started = now;
const summary: string[] = [];

for (const [i, fixture] of FIXTURES.entries()) {
	const tenantId = tenants.get(fixture.tenant) as string;
	const projectId = await createProject(control, {
		tenantId,
		name: fixture.project,
		dbNamespace: fixture.namespace,
	});
	// Create the vector column at the embedder's width BEFORE the lazy init inside
	// graphForProject bakes the 768 default. `init` is idempotent, so the later re-init is a no-op.
	await init(getDb(fixture.namespace), DIM);

	if (!rebuild) {
		summary.push(`${fixture.tenant}/${fixture.project}: cached`);
		continue;
	}

	const seedPrincipal: Principal = { userId: 'seed', tenantId, operator: true };
	const g = await graphForProject(control, seedPrincipal, projectId, 'write', demoSchema);
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
	const loaded = await applyPlan(g.raw, plan, embed, { maxEmbedded: SEED_EMBED });
	summary.push(
		`${fixture.tenant}/${fixture.project}: ${loaded.nodes} nodes (${loaded.versions} versions), ${loaded.edges} edges, ${loaded.embedded} embedded`,
	);
}

if (rebuild) writeCache(fp, namespaces);

const app = createApp({ control, schema: demoSchema, authenticate, embed });
app.route('/admin', createAdminApp({ control, authenticate: adminAuthenticate }));

Bun.serve({ port: PORT, fetch: app.fetch });
console.log(
	`[admin-api] http://localhost:${PORT}  token="${ADMIN_TOKEN}"  ${
		rebuild ? `built in ${((Date.now() - started) / 1000).toFixed(1)}s` : 'reused cached databases'
	}`,
);
for (const line of summary) console.log(`  ${line}`);
