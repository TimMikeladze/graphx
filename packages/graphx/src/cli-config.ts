import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GraphxConfig } from './core/config.ts';
import type { DbClient } from './core/dialect.ts';
import { getDb } from './core/db.ts';
import { type GraphEventOptions } from './core/events.ts';
import { Graph, type GraphSchema } from './core/graph.ts';
import { init } from './core/schema.ts';

/**
 * Loading `graphx.config.ts` — shared by every CLI subcommand and by `graphx mcp`, so all of
 * them see the same schema, embedder, namespace and backend.
 */

/** Keys a pre-rewrite config carried. Named so the error can say what replaced them. */
const REMOVED_KEYS: Record<string, string> = {
	embed: 'rename it to `embedder` and build it with defineEmbedder() / hashEmbed()',
	dim: 'delete it — the width is probed from the embedder and recorded in the namespace',
};

/**
 * Import + validate a user's `graphx.config.ts` default export, registering the backend driver
 * it selects (each an optional peer, loaded only when named).
 */
export async function loadConfig(configPath: string): Promise<GraphxConfig> {
	const configUrl = pathToFileURL(resolve(configPath)).href;
	const cfg = (await import(configUrl)).default as GraphxConfig | undefined;
	if (!cfg || typeof cfg !== 'object' || !cfg.schema) {
		throw new Error(`graphx: ${configPath} must default-export a config with \`schema\``);
	}
	for (const [key, fix] of Object.entries(REMOVED_KEYS)) {
		if (key in cfg)
			throw new Error(`graphx: ${configPath} sets \`${key}\`, which no longer exists — ${fix}`);
	}
	if (cfg.embedder && typeof cfg.embedder.embed !== 'function') {
		throw new Error(
			`graphx: ${configPath} \`embedder\` is not an Embedder — build it with defineEmbedder({ id, embed }) or hashEmbed()`,
		);
	}
	if (cfg.rerank !== undefined && typeof cfg.rerank !== 'function') {
		throw new Error(
			`graphx: ${configPath} \`rerank\` is not a function — build it with jevRerank() from graphx/jev, or write (query, candidates) => scores`,
		);
	}
	if (cfg.guard !== undefined && typeof cfg.guard !== 'function') {
		throw new Error(
			`graphx: ${configPath} \`guard\` is not a function — build it with jevGuard() from graphx/jev, or write (query, candidates) => kept ids`,
		);
	}
	if (cfg.db?.driver === 'postgres') await import('./core/pg.ts');
	if (cfg.db?.driver === 'duckdb') await import('./core/duck.ts');
	if (cfg.db?.driver === 'bql') await import('./core/bql.ts');
	return cfg;
}

/** The namespace a config addresses. */
export function namespaceOf(cfg: GraphxConfig): string {
	return cfg.namespace ?? 'graphx';
}

/**
 * Open (and cache) the config's project database. Cached under its namespace, so a later
 * `getDb(namespace)` with no config — the dev `createApp`'s path — returns this same client
 * instead of falling back to a libSQL file.
 */
export function openDb(cfg: GraphxConfig): DbClient {
	return getDb(namespaceOf(cfg), cfg.db ?? {});
}

/** Open the config's database, initialise it for the embedder, and wrap it in a `Graph`. */
export async function openGraph(
	cfg: GraphxConfig,
	events?: GraphEventOptions,
): Promise<Graph<GraphSchema>> {
	const client = openDb(cfg);
	await init(client, cfg.embedder);
	return new Graph(client, cfg.schema, {
		embedder: cfg.embedder,
		embedding: cfg.embedding,
		events,
	});
}
