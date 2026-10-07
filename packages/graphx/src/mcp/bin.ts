import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import process from 'node:process';
import { loadConfig, namespaceOf, openDb } from '../cli-config.ts';
import { createApp, type DbClient } from '../core/index.ts';
import { localBackend, remoteBackend } from './backend.ts';
import { createGraphxMcp } from './server.ts';

/**
 * `graphx mcp` — the stdio entry point an MCP client spawns.
 *
 * Local mode loads `graphx.config.ts` — the same schema, embedder, namespace and backend every
 * other subcommand uses — opens the database directly, and runs the serving app in-process.
 * Remote mode proxies a deployed server. Either way the tools are identical, because both go
 * through the same routes.
 *
 * NOTHING may be written to stdout: stdio transport frames JSON-RPC there, and a stray
 * `console.log` corrupts the stream. Diagnostics go to stderr.
 *
 * This module is reached ONLY through a dynamic `import()` in `cli.ts`. That is deliberate:
 * `@modelcontextprotocol/sdk` is an optional peer, so a static import here would drag it onto
 * the load path of `graphx serve` / `ingest` / `triggers` and break every install that never
 * asked for MCP.
 */

/**
 * `graphx_context` — where an agent gets the ids every other tool demands.
 *
 * Every tool requires a `tenant`, and nearly all also require a `project`. In local mode those
 * are minted fresh into an in-memory control plane on every start, so they differ each run and
 * appear in no config a client could read; without this tool there is no discovery path at all,
 * because `list_projects` needs the tenant it cannot know and there is no `list_tenants`.
 * Read-only, so it survives `--read-only`.
 */
function registerContext(server: McpServer, context: Record<string, unknown>): void {
	server.registerTool(
		'graphx_context',
		{
			description:
				'Call this FIRST. Returns the tenant and project ids that every other graphx tool takes as arguments. In local mode they are minted fresh on each start, so they cannot be guessed or carried over from a previous session.',
			annotations: { readOnlyHint: true },
		},
		() => ({
			content: [{ type: 'text' as const, text: JSON.stringify(context) }],
			structuredContent: context,
		}),
	);
}

export interface McpBinArgs {
	/** Path to `graphx.config.ts` (local mode). */
	config: string;
	readOnly: boolean;
}

/** Run the stdio MCP server until the transport closes. */
export async function runMcp(args: McpBinArgs): Promise<void> {
	const readOnly = args.readOnly || process.env.GRAPHX_MCP_READ_ONLY === '1';
	const mode = process.env.GRAPHX_MCP_MODE ?? (process.env.GRAPHX_URL ? 'remote' : 'local');

	let app: Parameters<typeof createGraphxMcp>[0]['app'];
	let backend: ReturnType<typeof localBackend>;
	let context: Record<string, unknown>;
	let schema: Parameters<typeof createGraphxMcp>[0]['schema'];

	if (mode === 'remote') {
		const url = process.env.GRAPHX_URL;
		if (!url) throw new Error('GRAPHX_MCP_MODE=remote requires GRAPHX_URL');
		// The route registry still comes from a locally built app: the tool surface is a
		// property of the graphx version, not of the deployment being addressed. The production
		// overload hands back that registry synchronously and touches no database, where the dev
		// bootstrap would run a full `init()` — writing a real graph into the CWD for an app
		// whose handlers are never reached (and failing outright from a read-only CWD).
		app = createApp({
			// Never dispatched to: this app exists only for its route registry. `createApp`
			// selects the production overload on `control` being truthy and reads nothing off it.
			control: {} as DbClient,
			schema: { nodes: {}, edges: {} },
			authenticate: () => {
				throw new Error('registry-only app');
			},
		});
		backend = remoteBackend({ url, apiKey: process.env.GRAPHX_API_KEY });
		// Honest about having nothing to report: a deployment's ids are not ours to mint.
		context = {
			mode: 'remote',
			url,
			tenant: null,
			project: null,
			note: 'This server proxies a deployed graphx. It mints no ids — supply the tenant and project from the deployment you are pointed at.',
		};
	} else {
		const cfg = await loadConfig(args.config);
		schema = cfg.schema;
		// Cache the client under the namespace with the config's backend settings BEFORE the dev
		// bootstrap opens it with a bare `getDb(namespace)`.
		openDb(cfg);
		const dev = await createApp({
			schema: cfg.schema,
			db: namespaceOf(cfg),
			embedder: cfg.embedder,
			embedding: cfg.embedding,
			upcasters: cfg.upcasters,
			rerank: cfg.rerank,
			guard: cfg.guard,
		});
		app = dev.app;
		backend = localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant });
		context = {
			mode: 'local',
			config: args.config,
			namespace: namespaceOf(cfg),
			embedder: cfg.embedder?.id ?? null,
			tenant: dev.tenant,
			project: dev.project,
		};
		if (!cfg.embedder) {
			process.stderr.write(
				'graphx mcp: the config has no `embedder`; retrieve / hybrid_search will answer 501\n',
			);
		}
		if (cfg.embedder && !cfg.guard) {
			process.stderr.write(
				'graphx mcp: the config has no `guard`; retrieved node bodies reach the agent unscreened (jevGuard() in graphx/jev screens them)\n',
			);
		}
	}

	const server = createGraphxMcp({ app, backend, readOnly, schema });
	registerContext(server, context);
	await server.connect(new StdioServerTransport());
}
