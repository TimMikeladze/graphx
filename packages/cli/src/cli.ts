import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { CreateAppResult, GraphSchema, EmbedFn, DbConfig } from '@graphx/core';
import { getDb, init, Graph, createApp } from '@graphx/core';
import { ingestDir, watchDir } from '@graphx/ingest';
import type { IngestResult } from '@graphx/ingest';

// ──────────────────────────────────────────────────────────────────────────────
// Arg parsing (exported for unit tests)
// ──────────────────────────────────────────────────────────────────────────────

export interface ParsedIngestArgs {
	dir: string;
	config: string;
	source: string | undefined;
	idField: string | undefined;
	prune: boolean;
	watch: boolean;
	assetsType: string | undefined;
}

export function parseIngestArgs(argv: string[]): ParsedIngestArgs {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c', default: './graphx.config.ts' },
			source: { type: 'string' },
			'id-field': { type: 'string' },
			prune: { type: 'boolean', default: false },
			watch: { type: 'boolean', short: 'w', default: false },
			'assets-type': { type: 'string' },
		},
	});

	// positionals[0] = subcommand ('ingest'), positionals[1] = dir
	const dir = positionals[1];
	if (!dir) throw new Error('ingest: missing <dir> argument');

	return {
		dir,
		config: (values.config as string | undefined) ?? './graphx.config.ts',
		source: values.source as string | undefined,
		idField: values['id-field'] as string | undefined,
		prune: (values.prune as boolean | undefined) ?? false,
		watch: (values.watch as boolean | undefined) ?? false,
		assetsType: values['assets-type'] as string | undefined,
	};
}

export interface ParsedServeArgs {
	config: string;
	port: number;
}

export function parseServeArgs(argv: string[]): ParsedServeArgs {
	const { values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c', default: './graphx.config.ts' },
			port: { type: 'string', short: 'p', default: '8899' },
		},
	});
	return {
		config: (values.config as string | undefined) ?? './graphx.config.ts',
		port: Number(values.port ?? 8899),
	};
}

export interface ParsedNewArgs {
	dir: string;
}

export function parseNewArgs(argv: string[]): ParsedNewArgs {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
	const dir = positionals[1]; // positionals[0] = 'new'
	if (!dir) throw new Error('new: missing <dir> argument');
	return { dir };
}

// ──────────────────────────────────────────────────────────────────────────────
// Config types
// ──────────────────────────────────────────────────────────────────────────────

interface GraphxConfig {
	schema: GraphSchema;
	embed: EmbedFn;
	db?: DbConfig;
	dim?: number;
	namespace?: string;
}

/** Import + return a user's `graphx.config.ts` default export (registers the pg driver if selected). */
async function loadConfig(configPath: string): Promise<GraphxConfig> {
	const configUrl = pathToFileURL(resolve(configPath)).href;
	const cfg: GraphxConfig = (await import(configUrl)).default;
	if (cfg.db?.driver === 'postgres') await import('@graphx/core/pg');
	return cfg;
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary printer
// ──────────────────────────────────────────────────────────────────────────────

/** Group skip entries by `code` into a compact `code=count code=count` string (empty if none). */
export function skipBreakdown(skipped: IngestResult['skipped']): string {
	if (skipped.length === 0) return '';
	const counts = new Map<string, number>();
	for (const s of skipped) counts.set(s.code, (counts.get(s.code) ?? 0) + 1);
	return [...counts].map(([code, n]) => `${code}=${n}`).join(' ');
}

function printSummary(result: IngestResult): void {
	const { added, updated, unchanged, deleted, edgesAdded, edgesClosed, skipped } = result;
	console.log(
		`added=${added} updated=${updated} unchanged=${unchanged} deleted=${deleted} ` +
			`edgesAdded=${edgesAdded} edgesClosed=${edgesClosed} skipped=${skipped.length}`,
	);
	// A bare count hides systemic failure (a schema/type/dim error rejecting every file). Surface
	// the codes so an operator can see WHY, not just that something was skipped.
	if (skipped.length > 0) console.log(`  skips: ${skipBreakdown(skipped)}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Usage / help
// ──────────────────────────────────────────────────────────────────────────────

const USAGE = `\
graphx CLI

Usage:
  graphx ingest <dir> [options]   Ingest a vault into the graph
  graphx serve [options]          Serve the graph over HTTP (typed routes + /openapi.json)
  graphx new <dir>                Scaffold a starter graphx project

ingest options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
  --source <id>           Logical source id (default: 'default')
  --id-field <name>       Frontmatter key for stable identity (default: 'id')
  --prune                 Retract nodes for files that vanished
  --watch, -w             Watch dir for changes after initial ingest
  --assets-type <type>    Enable asset nodes with this type

serve options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
  --port, -p <port>       Port to listen on (default: 8899)

  --help                  Show this help
`;

// ──────────────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────────────

export async function run(argv: string[]): Promise<void> {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		process.exit(0);
	}

	const subcommand = argv[0];

	if (!subcommand || subcommand === '--help') {
		process.stdout.write(USAGE);
		process.exit(0);
	}

	switch (subcommand) {
		case 'ingest':
			return runIngest(argv);
		case 'serve':
			return runServe(argv);
		case 'new':
			return runNew(argv);
		default:
			process.stderr.write(`graphx: unknown command '${subcommand}'\n\n${USAGE}`);
			process.exit(2);
	}
}

async function runIngest(argv: string[]): Promise<void> {
	const args = parseIngestArgs(argv);
	const cfg = await loadConfig(args.config);

	// `dim` MUST be set explicitly: it is baked into the vector column at first init and cannot be
	// changed later (CREATE TABLE IF NOT EXISTS). A wrong/default value silently rejects every node
	// at insert time (dimension mismatch), so refuse to guess.
	if (cfg.dim == null) {
		throw new Error(
			"graphx: config must set `dim` (the embedding dimension, e.g. 768) — it must match your embedder's output and cannot be changed after the first run",
		);
	}
	const client = getDb(cfg.namespace ?? 'graphx', cfg.db ?? {});
	await init(client, cfg.dim);
	const graph = new Graph(client, cfg.schema);

	const ingestOpts = {
		dir: args.dir,
		graph,
		embed: cfg.embed,
		source: args.source,
		idField: args.idField,
		prune: args.prune,
		assets: args.assetsType ? { type: args.assetsType } : undefined,
	};

	// Initial ingest run
	const result = await ingestDir(ingestOpts);
	printSummary(result);

	// Systemic failure: nothing was written but files were rejected (schema/type/dim error). Signal
	// it with a nonzero exit so CI/scripts don't read a total failure as a successful no-op.
	if (result.added === 0 && result.updated === 0 && result.skipped.length > 0) {
		process.exitCode = 1;
	}

	if (args.watch) {
		console.log(`Watching ${args.dir} for changes…`);
		const watcher = watchDir({ ...ingestOpts, onRun: printSummary });

		// Keep process alive and stop on SIGINT
		await new Promise<void>((resolve) => {
			process.once('SIGINT', () => {
				watcher.close();
				resolve();
			});
		});
	}
}

/**
 * `graphx serve` — load the config and expose the graph over HTTP via the batteries-included
 * `createApp` (typed routes + CDC + `GET /openapi.json`, `GET /demo` for the session ids). Opens the
 * SAME DB namespace `graphx ingest` writes to, so `ingest` then `serve` surfaces the ingested graph.
 * Dimension is derived from the embedder — no `dim` bookkeeping needed here.
 */
/**
 * Load a config and build the serving app (no listener) — the testable core of `graphx serve`.
 * Returns the dev `createApp` result ({@link https://hono.dev} app + bootstrapped ids + control DB).
 */
export async function buildServeApp(configPath: string): Promise<CreateAppResult<GraphSchema>> {
	const cfg = await loadConfig(configPath);
	// The dev `createApp` opens project DBs via `getDb(namespace)` WITHOUT a DbConfig, so a Postgres
	// config's driver/connectionString must be surfaced through the env that `getDb` also reads —
	// otherwise a `driver: 'postgres'` config would silently fall back to a libSQL file. `getDb` reads
	// the env synchronously DURING createApp (bootstrap opens the DB), so scope the mutation to that
	// call and restore it after — leaving it set would make a later buildServeApp with a different
	// driver inherit the wrong backend, and would leak into the rest of the process.
	const prevDriver = process.env.GRAPHX_DB_DRIVER;
	const prevUrl = process.env.GRAPHX_PG_URL;
	if (cfg.db?.driver === 'postgres') {
		process.env.GRAPHX_DB_DRIVER = 'postgres';
		if (cfg.db.connectionString) process.env.GRAPHX_PG_URL = cfg.db.connectionString;
	}
	try {
		return await createApp({
			schema: cfg.schema,
			embed: cfg.embed,
			db: cfg.namespace ?? 'graphx',
			dim: cfg.dim,
		});
	} finally {
		restoreEnv('GRAPHX_DB_DRIVER', prevDriver);
		restoreEnv('GRAPHX_PG_URL', prevUrl);
	}
}

/** Restore an env var to a captured prior value (deleting it if it was previously unset). */
function restoreEnv(key: string, prev: string | undefined): void {
	if (prev === undefined) delete process.env[key];
	else process.env[key] = prev;
}

async function runServe(argv: string[]): Promise<void> {
	const bun = (globalThis as { Bun?: { serve(o: { port: number; fetch: unknown }): unknown } }).Bun;
	if (!bun) {
		throw new Error('graphx serve requires the Bun runtime (run with `bun`)');
	}
	const args = parseServeArgs(argv);
	const { app, tenant, project, user } = await buildServeApp(args.config);
	bun.serve({ port: args.port, fetch: app.fetch });
	console.log(
		`graphx serving on http://localhost:${args.port}\n` +
			`  GET /demo          → { tenant, project, user }\n` +
			`  GET /docs          → API reference (Scalar)\n` +
			`  GET /openapi.json  → HTTP contract\n` +
			`  tenant=${tenant} project=${project} user=${user}`,
	);
	// Keep the process alive until interrupted.
	await new Promise<void>((resolve) => process.once('SIGINT', resolve));
}

/** True if `path` exists (file or dir). */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** This CLI's own version (packages share it in lockstep) — used to pin the scaffold's graphx deps. */
async function graphxVersion(): Promise<string> {
	try {
		const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
		return typeof pkg.version === 'string' ? pkg.version : '*';
	} catch {
		return '*';
	}
}

/** `graphx new <dir>` — scaffold a minimal, runnable project (config + package.json + README). */
async function runNew(argv: string[]): Promise<void> {
	const { dir } = parseNewArgs(argv);
	const target = resolve(dir);
	// Refuse to clobber an existing project — the scaffold overwrites, so guard the key file.
	const configPath = join(target, 'graphx.config.ts');
	if (await pathExists(configPath)) {
		throw new Error(`new: ${join(dir, 'graphx.config.ts')} already exists — refusing to overwrite`);
	}
	// Pin this CLI's version (packages are versioned in lockstep) — correct once they're published to
	// a registry you can install from. NOT `latest`, which misrepresents a 0.x package.
	const v = await graphxVersion();

	await mkdir(target, { recursive: true });
	await Promise.all([
		writeFile(configPath, SCAFFOLD_CONFIG),
		writeFile(join(target, 'package.json'), scaffoldPkg(`^${v}`)),
		writeFile(join(target, 'README.md'), SCAFFOLD_README),
	]);
	console.log(
		`Scaffolded graphx project in ${dir}/\n\n` +
			`  cd ${dir}\n` +
			`  bun install        # resolves @graphx/* from your registry (see README if not published)\n` +
			`  bun run serve      # http://localhost:8899\n`,
	);
}

/** The scaffold's package.json, with graphx deps pinned to `range`. */
function scaffoldPkg(range: string): string {
	return `${JSON.stringify(
		{
			name: 'graphx-app',
			private: true,
			type: 'module',
			scripts: {
				serve: 'graphx serve',
				ingest: 'graphx ingest ./vault',
			},
			dependencies: {
				'@graphx/core': range,
				'@graphx/cli': range,
				zod: '^4',
			},
		},
		null,
		2,
	)}\n`;
}

const SCAFFOLD_CONFIG = `import { defineGraphSchema, hashEmbed } from '@graphx/core';
import { z } from 'zod';

// Your graph's shape — types (node types) and rels (edge types).
export const schema = defineGraphSchema({
	nodes: {
		note: z.object({ title: z.string().optional() }),
	},
	edges: {
		links_to: { from: 'note', to: 'note' },
	},
});

// hashEmbed is a deterministic, model-free embedder for dev — swap in a real model for production.
export default {
	schema,
	embed: hashEmbed(768),
	dim: 768,
	namespace: 'graphx',
};
`;

const SCAFFOLD_README = `# graphx app

\`\`\`sh
bun install              # resolves @graphx/* from your registry (see below if not published)
bun run serve            # http://localhost:8899  (GET /demo, GET /docs, GET /openapi.json)
bun run ingest           # ingest ./vault into the graph
\`\`\`

Not published yet? \`bun install\` can't resolve \`@graphx/*\` from a registry, and the source
packages use the \`workspace:\` protocol so they can't be \`file:\`-linked directly. Until they're
published, develop this app **inside the graphx repo** — add its path to the repo's root
\`package.json\` \`workspaces\` array, then \`bun install\` from the repo root (the \`workspace:\`
deps resolve there).

Edit \`graphx.config.ts\` to shape your graph. Point a \`@graphx/react\` client at the server with
\`<GraphProvider bootstrap="/demo" fetch={...} />\`.
`;

// Invoke when run as a script
if (import.meta.main) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
