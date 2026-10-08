/**
 * Dev API for the podcast example — serves the graph to the Podcast Atlas app (`web/`) and to
 * `graphx-admin`.
 *
 *   bun run dev:lex              # from the repo root: this API + the Atlas app, one Ctrl-C
 *   bun run server.ts            # just the API, on :8790 (PORT to change)
 *
 * Three realms on one port:
 *   /atlas/*   the Atlas's read-only routes (`api.ts`)
 *   /t/*       graphx's generated graph routes
 *   /admin/*   the operator registry the admin UI needs
 *
 * Auth: the dev bearer token (`ADMIN_TOKEN`, default "dev") is an operator. A request without a
 * token is the public `viewer` member — it can read the project and nothing else, which is all the
 * Atlas needs (its time scrubber reads `/t/…/timeline`). NOT for production — the control plane is
 * `:memory:` and the project DB is the same `podcasts.db` that `load.ts` writes. With a built app in
 * `web/dist`, the server also serves it at `/`.
 *
 * Every start syncs `data/<podcast>/episodes.json` for every show into the graph (idempotent: a
 * no-op when nothing changed), scraping first any show that has no scrape yet.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createClient } from '@libsql/client';
import type { Context } from 'hono';
import { serveStatic } from 'hono/bun';
import {
	addMembership,
	createAdminApp,
	createApp,
	createProject,
	createTenant,
	createUser,
	graphForProject,
	initControl,
	type Principal,
} from 'graphx';
import { createAtlasApi } from './api.ts';
import { planEpisodes } from './dataset.ts';
import { embedderFor, NAMESPACE, podcastSchema } from './graphx.config.ts';
import { readEpisodes, syncPlan } from './load.ts';
import { PODCASTS } from './podcasts/index.ts';
import { episodesFile, scrape } from './scrape.ts';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev';
const PORT = Number(process.env.PORT ?? 8790);
const embedder = embedderFor();

for (const p of PODCASTS) {
	if (existsSync(episodesFile(p.key))) continue;
	console.log(`[podcasts] no scrape of ${p.key} yet — scraping`);
	await scrape(p.key);
}

// --- control plane (always fresh; it is :memory:) ------------------------------------------------

const control = createClient({ url: ':memory:' });
await initControl(control);
const tenantId = await createTenant(control, { name: 'Podcasts' });
const userId = await createUser(control, { email: 'listener@podcasts.test' });
await addMembership(control, { userId, tenantId, role: 'owner' });
// Who an unauthenticated request is: a member who can read and not write.
const publicUserId = await createUser(control, { email: 'public@podcasts.test' });
await addMembership(control, { userId: publicUserId, tenantId, role: 'viewer' });
const projectId = await createProject(control, {
	tenantId,
	name: 'Episodes',
	dbNamespace: NAMESPACE,
});

// --- sync ------------------------------------------------------------------------------------------

const graph = await graphForProject(
	control,
	{ userId: 'seed', tenantId, operator: true } satisfies Principal,
	projectId,
	'write',
	podcastSchema,
	{ embedder },
);
const stats = await syncPlan(graph.raw, planEpisodes(await readEpisodes()), { embedder });
const summary =
	`${Object.values(stats.types).reduce((a, b) => a + b, 0)} nodes, ` +
	`${Object.values(stats.rels).reduce((a, b) => a + b, 0)} edges ` +
	`(${stats.nodes.inserted} inserted, ${stats.nodes.updated} updated this start)`;

// --- serve -----------------------------------------------------------------------------------------

function bearer(c: Context): string | undefined {
	const header = c.req.header('authorization') ?? '';
	return header.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/**
 * Tenant-scoped authn: the dev token ⇒ an operator; no token ⇒ the public viewer; any other token
 * is refused rather than quietly downgraded.
 */
function authenticate(c: Context): Principal {
	const token = bearer(c);
	const tenant = c.req.param('tenant') as string;
	if (token === ADMIN_TOKEN) return { userId: 'operator', tenantId: tenant, operator: true };
	if (token === undefined) return { userId: publicUserId, tenantId: tenant };
	throw new Error('unauthorized');
}

/** Operator authn for `/admin/*`: the same dev token. */
function adminAuthenticate(c: Context): void {
	if (bearer(c) !== ADMIN_TOKEN) throw new Error('unauthorized');
}

const app = createApp({ control, schema: podcastSchema, authenticate, embedder, cors: true });
app.route('/admin', createAdminApp({ control, authenticate: adminAuthenticate }));
app.route(
	'/atlas',
	createAtlasApi({ db: graph.raw, embedder, tenant: tenantId, project: projectId }),
);

// The built Atlas (`bun run build` in web/), when there is one. In dev, Vite serves it instead.
const dist = join(import.meta.dir, 'web', 'dist');
if (existsSync(dist)) {
	app.use('/*', serveStatic({ root: dist }));
	app.get('/*', serveStatic({ path: join(dist, 'index.html') }));
}

Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[podcasts] http://localhost:${PORT}  token="${ADMIN_TOKEN}"  ${summary}`);
