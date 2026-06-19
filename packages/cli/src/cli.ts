import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { GraphSchema, EmbedFn, DbConfig } from 'core';
import { getDb, init, Graph } from 'core';
import { ingestDir, watchDir } from 'ingest';
import type { IngestResult } from 'ingest';

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
	assetsKind: string | undefined;
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
			'assets-kind': { type: 'string' },
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
		assetsKind: values['assets-kind'] as string | undefined,
	};
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
	// A bare count hides systemic failure (a schema/kind/dim error rejecting every file). Surface
	// the codes so an operator can see WHY, not just that something was skipped.
	if (skipped.length > 0) console.log(`  skips: ${skipBreakdown(skipped)}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Usage / help
// ──────────────────────────────────────────────────────────────────────────────

const USAGE = `\
graphx CLI

Usage:
  graphx ingest <dir> [options]

Options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
  --source <id>           Logical source id (default: 'default')
  --id-field <name>       Frontmatter key for stable identity (default: 'id')
  --prune                 Retract nodes for files that vanished
  --watch, -w             Watch dir for changes after initial ingest
  --assets-kind <kind>    Enable asset nodes with this kind
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

	if (subcommand !== 'ingest') {
		process.stderr.write(`graphx: unknown command '${subcommand}'\n\n${USAGE}`);
		process.exit(2);
	}

	const args = parseIngestArgs(argv);

	// Load user config
	const configPath = resolve(args.config);
	const configUrl = pathToFileURL(configPath).href;
	const configMod = await import(configUrl);
	const cfg: GraphxConfig = configMod.default;

	// Register the Postgres adapter BEFORE calling getDb, if needed
	if (cfg.db?.driver === 'postgres') {
		await import('core/pg');
	}

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
		assets: args.assetsKind ? { kind: args.assetsKind } : undefined,
	};

	// Initial ingest run
	const result = await ingestDir(ingestOpts);
	printSummary(result);

	// Systemic failure: nothing was written but files were rejected (schema/kind/dim error). Signal
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

// Invoke when run as a script
if (import.meta.main) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
