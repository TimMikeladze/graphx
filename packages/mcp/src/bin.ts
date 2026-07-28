import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import process from 'node:process';
import { createApp, type DbClient, hashEmbed } from '@graphx/core';
import { localBackend, remoteBackend } from './backend.ts';
import { createGraphxMcp } from './server.ts';

/**
 * `graphx-mcp` — the stdio entry point an MCP client spawns.
 *
 * Local mode opens the database directly and runs the serving app in-process. Remote mode
 * proxies a deployed server. Either way the tools are identical, because both go through the
 * same routes.
 *
 * NOTHING may be written to stdout: stdio transport frames JSON-RPC there, and a stray
 * `console.log` corrupts the stream. Diagnostics go to stderr.
 */

/**
 * `graphx_context` — where an agent gets the ids every other tool demands.
 *
 * All 26 tools require a `tenant`, and 25 also require a `project`. In local mode those are
 * minted fresh into an in-memory control plane on every start, so they differ each run and
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

/**
 * A graph schema is a TypeScript value, so the binary cannot import one. It runs schemaless,
 * and in LOCAL mode that costs more than it sounds: `Graph.addNode` rejects every type it has
 * no definition for, so `create_node`, `create_edge` and `bulk_load` always 400 there, and
 * `update_node`/`delete_node` have nothing to act on. Remote mode is unaffected — the
 * deployment validates against its own schema, and the empty one here only supplies the route
 * registry. `describe_schema` samples types off the graph and flags them `inferred`. Import
 * this package instead of spawning the binary to write to a local graph.
 */
async function main(): Promise<void> {
	const readOnly = process.argv.includes('--read-only') || process.env.GRAPHX_MCP_READ_ONLY === '1';
	const mode = process.env.GRAPHX_MCP_MODE ?? (process.env.GRAPHX_URL ? 'remote' : 'local');

	let app: Parameters<typeof createGraphxMcp>[0]['app'];
	let backend: ReturnType<typeof localBackend>;
	let context: Record<string, unknown>;

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
		const db = process.env.GRAPHX_DB;
		if (!db) throw new Error('GRAPHX_MCP_MODE=local requires GRAPHX_DB');
		const dev = await createApp({ schema: { nodes: {}, edges: {} }, db, embed: hashEmbed() });
		app = dev.app;
		backend = localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant });
		context = { mode: 'local', db: `${db}.db`, tenant: dev.tenant, project: dev.project };
		// hashEmbed is lexical, not semantic. Saying so beats letting `retrieve` look broken.
		process.stderr.write(
			'graphx-mcp: no embedder configured; retrieve/hybrid use hashEmbed (lexical, not semantic)\n',
		);
	}

	const server = createGraphxMcp({ app, backend, readOnly });
	registerContext(server, context);
	await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
	process.stderr.write(`graphx-mcp: ${(err as Error).message}\n`);
	process.exit(1);
});
