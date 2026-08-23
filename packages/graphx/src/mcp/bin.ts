import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { createApp, type DbClient, type GraphSchema, hashEmbed } from '../core/index.ts';
import { localBackend, remoteBackend } from './backend.ts';
import { parseSchemaFile } from './schema-file.ts';
import { createGraphxMcp } from './server.ts';

/**
 * `graphx mcp` — the stdio entry point an MCP client spawns.
 *
 * Local mode opens the database directly and runs the serving app in-process. Remote mode
 * proxies a deployed server. Either way the tools are identical, because both go through the
 * same routes.
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
 * A graph schema is a TypeScript value, so the binary cannot import one directly — but
 * `GRAPHX_SCHEMA` can point it at a JSON file instead (see `schema-file.ts`). Without it, LOCAL
 * mode runs schemaless, and that costs more than it sounds: `Graph.addNode` rejects every type
 * it has no definition for, so `create_node`, `create_edge` and `bulk_load` always 400 there,
 * and `update_node`/`delete_node` have nothing to act on. `describe_schema` falls back to
 * sampling types off the graph and flags them `inferred`. Remote mode is unaffected either way
 * — the deployment validates against its own schema, and the empty one here only supplies the
 * route registry.
 */
function loadSchema(path: string | undefined): GraphSchema | undefined {
	if (!path) return undefined;
	// Errors here (missing file, bad JSON, an unsupported construct) propagate to `main`'s
	// top-level `.catch`, which prints a clear stderr message and exits 1 — never a bare stack
	// trace.
	return parseSchemaFile(JSON.parse(readFileSync(path, 'utf8')), path);
}

/**
 * Run the stdio MCP server until the transport closes. `argv` is the CLI's argument list
 * (`['mcp', ...flags]`), read for `--read-only` rather than `process.argv` so the flag is scoped
 * to this subcommand.
 */
export async function runMcp(argv: string[] = []): Promise<void> {
	const readOnly = argv.includes('--read-only') || process.env.GRAPHX_MCP_READ_ONLY === '1';
	const mode = process.env.GRAPHX_MCP_MODE ?? (process.env.GRAPHX_URL ? 'remote' : 'local');

	let app: Parameters<typeof createGraphxMcp>[0]['app'];
	let backend: ReturnType<typeof localBackend>;
	let context: Record<string, unknown>;
	let schema: GraphSchema | undefined;

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
		// `createApp`'s dev bootstrap opens the project DB via `getDb(namespace)`, which resolves
		// its backend off `GRAPHX_DB_DRIVER` — but the pg/duck adapters only register themselves as
		// a side effect of importing their subpath (each an optional peer, so neither loads for
		// consumers who never select it). Mirrors the config-driven import in `cli.ts`'s
		// `loadConfig`, keyed off the env var here since local mode has no config file.
		if (process.env.GRAPHX_DB_DRIVER === 'postgres') await import('../core/pg.ts');
		if (process.env.GRAPHX_DB_DRIVER === 'duckdb') await import('../core/duck.ts');
		const schemaPath = process.env.GRAPHX_SCHEMA;
		schema = loadSchema(schemaPath);
		const dev = await createApp({
			schema: schema ?? { nodes: {}, edges: {} },
			db,
			embed: hashEmbed(),
		});
		app = dev.app;
		backend = localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant });
		context = {
			mode: 'local',
			db: `${db}.db`,
			tenant: dev.tenant,
			project: dev.project,
			schema: schemaPath ?? null,
		};
		// hashEmbed is lexical, not semantic. Saying so beats letting `retrieve` look broken.
		process.stderr.write(
			'graphx mcp: no embedder configured; retrieve/hybrid use hashEmbed (lexical, not semantic)\n',
		);
	}

	const server = createGraphxMcp({ app, backend, readOnly, schema });
	registerContext(server, context);
	await server.connect(new StdioServerTransport());
}
