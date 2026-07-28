import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import process from 'node:process';
import { createApp, hashEmbed } from '@graphx/core';
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
 * A graph schema is a TypeScript value, so the binary cannot import one. It runs
 * schemaless: writes still work (the server validates), and `describe_schema` samples types
 * from the graph and flags them `inferred`. Embed a schema by importing this package instead
 * of spawning the binary.
 */
async function main(): Promise<void> {
	const readOnly = process.argv.includes('--read-only') || process.env.GRAPHX_MCP_READ_ONLY === '1';
	const mode = process.env.GRAPHX_MCP_MODE ?? (process.env.GRAPHX_URL ? 'remote' : 'local');

	let app: Parameters<typeof createGraphxMcp>[0]['app'];
	let backend: ReturnType<typeof localBackend>;

	if (mode === 'remote') {
		const url = process.env.GRAPHX_URL;
		if (!url) throw new Error('GRAPHX_MCP_MODE=remote requires GRAPHX_URL');
		// The route registry still comes from a locally built app: the tool surface is a
		// property of the graphx version, not of the deployment being addressed.
		const dev = await createApp({
			schema: { nodes: {}, edges: {} },
			db: ':memory:',
			embed: hashEmbed(),
		});
		app = dev.app;
		backend = remoteBackend({ url, apiKey: process.env.GRAPHX_API_KEY });
	} else {
		const db = process.env.GRAPHX_DB;
		if (!db) throw new Error('GRAPHX_MCP_MODE=local requires GRAPHX_DB');
		const dev = await createApp({ schema: { nodes: {}, edges: {} }, db, embed: hashEmbed() });
		app = dev.app;
		backend = localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant });
		// hashEmbed is lexical, not semantic. Saying so beats letting `retrieve` look broken.
		process.stderr.write(
			'graphx-mcp: no embedder configured; retrieve/hybrid use hashEmbed (lexical, not semantic)\n',
		);
	}

	const server = createGraphxMcp({ app, backend, readOnly });
	await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
	process.stderr.write(`graphx-mcp: ${(err as Error).message}\n`);
	process.exit(1);
});
