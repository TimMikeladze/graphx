// Native/server public API, including the shared driver-free graph engine.
export * from './portable.ts';

// HTTP webhook delivery uses fetch and WebCrypto; local triggers live in core.
export { webhookAction, type WebhookOptions } from './triggers.ts';

// P0 — connection / pragmas
export {
	applyConnPragmas,
	closeAll,
	type DbConfig,
	evict,
	FOREVER,
	getDb,
	syncIfReplica,
} from './db.ts';

// P0.5 — control plane + authz
export {
	addMembership,
	CONTROL_SCHEMA,
	createApiKey,
	createProject,
	createTenant,
	createUser,
	hashApiKey,
	initControl,
	listProjects,
	listTenants,
	listUsers,
} from './control-plane.ts';
// Admin — operator-gated control-plane CRUD sub-app (mount with app.route('/admin', ...))
export { type AdminConfig, createAdminApp } from './admin.ts';
export {
	AuthzError,
	authorize,
	type Op,
	type Principal,
	resolveProjectDb,
	type Role,
} from './authz.ts';

// `graphx.config.ts` — the contract every CLI command and `graphx mcp` loads
export { defineConfig, type GraphxConfig } from './config.ts';

// Record/replay embedder — real model vectors, committed once, replayed offline
export { fixtureEmbed, type FixtureEmbedder, type FixtureEmbedOpts } from './embed-fixture.ts';

// P11 — serving (Hono app + typed client) + P15 readiness latch (§19.6). The HTTP contract is
// generated from the route definitions and served at `GET /openapi.json` (`OpenApiOptions` only
// sets the document's info/servers).
export {
	type AppType,
	createApp,
	type CreateAppResult,
	createReadiness,
	type DevServeConfig,
	graphForProject,
	type OpenApiOptions,
	type Readiness,
	type ServeConfig,
	type ServeEnv,
} from './serve.ts';
