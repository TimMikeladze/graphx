import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { CreateAppResult, GraphSchema } from './core/index.ts';
import { createApp, fork, getDb, Graph, init, TriggerRunner } from './core/index.ts';
import { loadConfig, namespaceOf, openDb, openGraph } from './cli-config.ts';
import { ingestDir, watchDir } from './ingest/index.ts';
import type { IngestResult } from './ingest/index.ts';
import { askGraph, type PairJudgment, resolveEntities } from './jev/index.ts';

export { loadConfig, namespaceOf, openDb, openGraph } from './cli-config.ts';

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
	edgeFields: Record<string, string> | undefined;
	danglingType: string | undefined;
	tagsType: string | undefined;
}

/**
 * Parse repeated `--edge-field field=rel` pairs into the `edgeFields` map. A malformed pair
 * throws rather than being dropped: silently ignoring it would produce a successful run that
 * quietly built none of the edges the operator asked for.
 */
function parseEdgeFields(raw: string[] | undefined): Record<string, string> | undefined {
	if (!raw || raw.length === 0) return undefined;
	const out: Record<string, string> = {};
	for (const pair of raw) {
		const eq = pair.indexOf('=');
		const field = eq === -1 ? '' : pair.slice(0, eq).trim();
		const rel = eq === -1 ? '' : pair.slice(eq + 1).trim();
		if (!field || !rel) {
			throw new Error(`ingest: --edge-field expects 'field=rel', got '${pair}'`);
		}
		out[field] = rel;
	}
	return out;
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
			'edge-field': { type: 'string', multiple: true },
			'dangling-type': { type: 'string' },
			'tags-type': { type: 'string' },
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
		edgeFields: parseEdgeFields(values['edge-field'] as string[] | undefined),
		danglingType: values['dangling-type'] as string | undefined,
		tagsType: values['tags-type'] as string | undefined,
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

export interface ParsedTriggersArgs {
	config: string;
}

export function parseTriggersArgs(argv: string[]): ParsedTriggersArgs {
	const { values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c', default: './graphx.config.ts' },
		},
	});
	return { config: (values.config as string | undefined) ?? './graphx.config.ts' };
}

export interface ParsedReembedArgs {
	config: string;
	dryRun: boolean;
}

export function parseReembedArgs(argv: string[]): ParsedReembedArgs {
	const { values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c', default: './graphx.config.ts' },
			'dry-run': { type: 'boolean', default: false },
		},
	});
	return {
		config: (values.config as string | undefined) ?? './graphx.config.ts',
		dryRun: (values['dry-run'] as boolean | undefined) ?? false,
	};
}

export interface ParsedForkArgs {
	config: string;
	target: string;
	asOf: number | undefined;
}

/** `--as-of` takes epoch ms or anything `Date.parse` reads (an ISO timestamp). */
function parseInstant(raw: string): number {
	const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
	if (!Number.isFinite(t))
		throw new Error(`fork: --as-of expects epoch ms or an ISO date, got '${raw}'`);
	return t;
}

export function parseForkArgs(argv: string[]): ParsedForkArgs {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c', default: './graphx.config.ts' },
			'as-of': { type: 'string' },
		},
	});
	const target = positionals[1];
	if (!target) throw new Error('fork: missing <namespace> argument');
	const asOf = values['as-of'] as string | undefined;
	return {
		config: (values.config as string | undefined) ?? './graphx.config.ts',
		target,
		asOf: asOf === undefined ? undefined : parseInstant(asOf),
	};
}

export interface ParsedMcpArgs {
	config: string;
	readOnly: boolean;
}

export function parseMcpArgs(argv: string[]): ParsedMcpArgs {
	const { values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c', default: './graphx.config.ts' },
			'read-only': { type: 'boolean', default: false },
		},
	});
	return {
		config: (values.config as string | undefined) ?? './graphx.config.ts',
		readOnly: (values['read-only'] as boolean | undefined) ?? false,
	};
}

export interface ParsedDedupeArgs {
	type: string;
	config: string;
	fields?: string[];
	candidates: number;
	limit?: number;
	sameRel?: string;
	reviewRel?: string;
	dryRun: boolean;
}

export function parseDedupeArgs(argv: string[]): ParsedDedupeArgs {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c', default: './graphx.config.ts' },
			fields: { type: 'string' },
			candidates: { type: 'string', default: '5' },
			limit: { type: 'string' },
			'same-rel': { type: 'string' },
			'review-rel': { type: 'string' },
			'dry-run': { type: 'boolean', default: false },
		},
	});
	const type = positionals[1];
	if (!type) throw new Error('dedupe: missing <type> — the node type to resolve');
	const int = (flag: string, raw: string | undefined): number | undefined => {
		if (raw === undefined) return undefined;
		const n = Number(raw);
		if (!Number.isInteger(n) || n < 1)
			throw new Error(`dedupe: --${flag} must be a positive integer`);
		return n;
	};
	const dryRun = (values['dry-run'] as boolean | undefined) ?? false;
	return {
		type,
		config: (values.config as string | undefined) ?? './graphx.config.ts',
		fields: (values.fields as string | undefined)
			?.split(',')
			.map((f) => f.trim())
			.filter(Boolean),
		candidates: int('candidates', values.candidates as string | undefined) ?? 5,
		limit: int('limit', values.limit as string | undefined),
		sameRel: dryRun ? undefined : (values['same-rel'] as string | undefined),
		reviewRel: dryRun ? undefined : (values['review-rel'] as string | undefined),
		dryRun,
	};
}

export interface ParsedAskArgs {
	question: string;
	config: string;
	limit: number;
}

export function parseAskArgs(argv: string[]): ParsedAskArgs {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c', default: './graphx.config.ts' },
			limit: { type: 'string', default: '10' },
		},
	});
	const question = positionals.slice(1).join(' ').trim();
	if (!question)
		throw new Error('ask: missing the question — graphx ask "which gateways raised alerts?"');
	const limit = Number(values.limit ?? 10);
	if (!Number.isInteger(limit) || limit < 1)
		throw new Error('ask: --limit must be a positive integer');
	return { question, config: (values.config as string | undefined) ?? './graphx.config.ts', limit };
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
  graphx triggers [options]       Run declarative triggers over the event outbox
  graphx mcp [options]            Serve the graph to an MCP client over stdio
  graphx reembed [options]        Re-embed every live node with the configured embedder
  graphx doctor [options]         Report the namespace's embedding model, width, and health
  graphx fork <namespace>         Branch the configured namespace into a new, empty one
  graphx dedupe <type> [options]  Find duplicate nodes of a type and judge them with Jev
  graphx ask "<question>"         Plan a plain-language question as a graph call with Jev, and run it
  graphx new <dir>                Scaffold a starter graphx project

ingest options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
  --source <id>           Logical source id (default: 'default')
  --id-field <name>       Frontmatter key for stable identity (default: 'id')
  --prune                 Retract nodes for files that vanished
  --watch, -w             Watch dir for changes after initial ingest
  --assets-type <type>    Enable asset nodes with this type
  --edge-field <f=rel>    Map a frontmatter field to an edge rel (repeatable)
  --dangling-type <type>  Enable stub nodes for links to notes that don't exist
  --tags-type <type>      Enable shared tag nodes with this type

serve options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
  --port, -p <port>       Port to listen on (default: 8899)

triggers options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)

reembed options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
  --dry-run               Report what would change without writing

doctor options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)

fork options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
  --as-of <ms|ISO date>   Branch the graph as it stood at this instant

dedupe options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
  --fields <a,b>          Data fields Jev sees and compares (default: all)
  --candidates <n>        Nearest same-type neighbours judged per node (default: 5)
  --limit <n>             Resolve only the first n nodes
  --same-rel <rel>        Link same-entity pairs with this rel
  --review-rel <rel>      Link pairs for a curator with this rel
  --dry-run               Judge and report; write nothing
  TYPESAFE_API_KEY        Jev API key

ask options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
  --limit <n>             Rows to return (default: 10)
  TYPESAFE_API_KEY        Jev API key

mcp options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts) — local mode
  --read-only             Expose only the read tools
  GRAPHX_URL              Deployed server to proxy instead (remote mode), + GRAPHX_API_KEY

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
		case 'triggers':
			return runTriggers(argv);
		case 'reembed':
			return runReembed(argv);
		case 'doctor':
			return runDoctor(argv);
		case 'fork':
			return runFork(argv);
		case 'dedupe':
			return runDedupe(argv);
		case 'ask':
			return runAsk(argv);
		case 'mcp':
			// Dynamic: `@modelcontextprotocol/sdk` is an OPTIONAL peer, so a static import would
			// put it on the load path of every other subcommand and break installs that never
			// opted into MCP. Note the stdio transport frames JSON-RPC on stdout — nothing on this
			// path may write there.
			return (await import('./mcp/bin.ts')).runMcp(parseMcpArgs(argv));
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
	const graph = await openGraph(cfg);

	const ingestOpts = {
		dir: args.dir,
		graph,
		source: args.source,
		idField: args.idField,
		prune: args.prune,
		assets: args.assetsType ? { type: args.assetsType } : undefined,
		edgeFields: args.edgeFields,
		dangling: args.danglingType ? { type: args.danglingType } : undefined,
		tags: args.tagsType ? { type: args.tagsType } : undefined,
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
 */
/**
 * Load a config and build the serving app (no listener) — the testable core of `graphx serve`.
 * Returns the dev `createApp` result ({@link https://hono.dev} app + bootstrapped ids + control DB).
 */
export async function buildServeApp(configPath: string): Promise<CreateAppResult<GraphSchema>> {
	const cfg = await loadConfig(configPath);
	// The dev `createApp` opens project DBs via a bare `getDb(namespace)`. Opening the client HERE,
	// with the config's backend settings, caches it under that namespace first — so the bootstrap
	// finds this client instead of falling back to a libSQL file.
	openDb(cfg);
	return createApp({
		schema: cfg.schema,
		embedder: cfg.embedder,
		embedding: cfg.embedding,
		rerank: cfg.rerank,
		guard: cfg.guard,
		db: namespaceOf(cfg),
	});
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

/**
 * `graphx triggers` — host the durable trigger runner. Triggers are functions, so they come from
 * the config module rather than the database; the runner keeps its cursor in `trigger_cursors`, so
 * restarting this process resumes where it left off instead of replaying or skipping.
 */
async function runTriggers(argv: string[]): Promise<void> {
	const args = parseTriggersArgs(argv);
	const cfg = await loadConfig(args.config);
	if (!cfg.triggers || cfg.triggers.length === 0) {
		throw new Error(`triggers: ${args.config} exports no \`triggers\` — nothing to run`);
	}
	// The outbox is the substrate triggers read; without it there is nothing to tail.
	const graph = await openGraph(cfg, { outbox: true });
	const name = cfg.triggerRunner?.name ?? 'graphx';
	const runner = new TriggerRunner(graph, { ...cfg.triggerRunner, name, triggers: cfg.triggers });

	runner.start();
	console.log(
		`graphx triggers running — subscription '${name}', ${cfg.triggers.length} trigger(s)\n` +
			`  ${cfg.triggers.map((t) => t.name).join(', ')}`,
	);
	// Keep the process alive until interrupted, then drain the in-flight cycle.
	await new Promise<void>((resolve) => process.once('SIGINT', resolve));
	await runner.stop();
}

/**
 * `graphx reembed` — re-embed every live node under the configured embedder. This is also how a
 * namespace switches models: the stored vectors are dropped and the table is recreated for the
 * new model before the pass.
 */
async function runReembed(argv: string[]): Promise<void> {
	const args = parseReembedArgs(argv);
	const cfg = await loadConfig(args.config);
	if (!cfg.embedder) throw new Error('reembed: the config has no `embedder`');
	const client = openDb(cfg);
	// Do NOT `init(client, embedder)` here: on a model change it would refuse. Open the graph
	// without initialising the embeddings and let `reembed` replace them.
	await init(client);
	const graph = new Graph(client, cfg.schema, { embedder: cfg.embedder, embedding: 'off' });
	const before = await graph.embeddingReport();
	console.log(
		`namespace=${namespaceOf(cfg)} stored=${before.stored ? `${before.stored.model} (${before.stored.dim})` : 'none'} ` +
			`configured=${cfg.embedder.id} liveNodes=${before.liveNodes} embedded=${before.embedded} stale=${before.stale}`,
	);
	if (args.dryRun) {
		console.log(`dry run: would re-embed ${before.liveNodes} live node(s)`);
		return;
	}
	const result = await graph.reembed({
		onProgress: (done) => process.stderr.write(`  ${done}/${before.liveNodes}\r`),
	});
	process.stderr.write('\n');
	console.log(
		`reembedded nodes=${result.nodes} embedded=${result.embedded} skipped=${result.skipped}`,
	);
}

/**
 * `graphx fork <namespace>` — branch the configured namespace into another on the same backend.
 * A DuckDB `duckPath` names one file, so the branch gets its own default path instead.
 */
async function runFork(argv: string[]): Promise<void> {
	const args = parseForkArgs(argv);
	const cfg = await loadConfig(args.config);
	if (args.target === namespaceOf(cfg))
		throw new Error('fork: the target is the configured namespace');
	const source = openDb(cfg);
	await init(source);
	const target = getDb(args.target, { ...cfg.db, duckPath: undefined });
	const result = await fork(source, target, { asOf: args.asOf });
	if (cfg.embedder && result.needsEmbedding.length > 0) {
		const branch = new Graph(target, cfg.schema, { embedder: cfg.embedder });
		for (const id of result.needsEmbedding) await branch.embedNode(id);
	}
	console.log(
		`forked ${namespaceOf(cfg)} -> ${args.target} (${result.method})${result.asOf === null ? '' : ` asOf=${new Date(result.asOf).toISOString()}`} ` +
			`nodes=${result.nodes} edges=${result.edges} versions=${result.nodeVersions + result.edgeVersions} ` +
			`vectors=${result.vectors} reembedded=${cfg.embedder ? result.needsEmbedding.length : 0}`,
	);
}

/**
 * `graphx dedupe` — resolve duplicate nodes of one type with Jev. Candidates come from the
 * config's embedder, so it needs one. Without a rel flag nothing is written: the run is a report.
 */
async function runDedupe(argv: string[]): Promise<void> {
	const args = parseDedupeArgs(argv);
	const cfg = await loadConfig(args.config);
	if (!cfg.embedder)
		throw new Error('dedupe: the config has no `embedder` to find candidates with');
	if (!(args.type in cfg.schema.nodes)) throw new Error(`dedupe: unknown node type '${args.type}'`);
	for (const rel of [args.sameRel, args.reviewRel]) {
		if (rel && !(rel in cfg.schema.edges)) throw new Error(`dedupe: unknown rel '${rel}'`);
	}
	const graph = await openGraph(cfg);
	const label = new Map<string, string>();
	const name = async (id: string): Promise<string> => {
		if (!label.has(id)) {
			const data = ((await graph.getNode(id))?.data ?? {}) as Record<string, unknown>;
			const first = Object.values(data).find((v) => typeof v === 'string' && v);
			label.set(id, String(first ?? id).slice(0, 40));
		}
		return label.get(id)!;
	};
	let done = 0;
	const report = await resolveEntities(graph, {
		type: args.type,
		fields: args.fields,
		candidates: args.candidates,
		limit: args.limit,
		rels: { same: args.sameRel, review: args.reviewRel },
		onJudgment: () => process.stderr.write(`  judged ${++done}\r`),
	});
	process.stderr.write('\n');
	const line = async (p: PairJudgment): Promise<string> => {
		const disagree = Object.entries(p.fields)
			.filter(([, v]) => v < 0.5)
			.map(([k, v]) => `${k} ${v.toFixed(2)}`);
		return (
			`  ${(await name(p.a)).padEnd(40)} ~ ${(await name(p.b)).padEnd(40)} ` +
			`score ${p.score.toFixed(2)} conf ${p.confidence.toFixed(2)}` +
			(disagree.length ? `  disagree: ${disagree.join(', ')}` : '') +
			`  [${p.a} ${p.b}]`
		);
	};
	for (const outcome of ['same', 'review'] as const) {
		const rows = report.pairs.filter((p) => p.outcome === outcome);
		if (rows.length === 0) continue;
		console.log(outcome === 'same' ? 'same entity:' : 'for a curator:');
		for (const p of rows) console.log(await line(p));
	}
	for (const f of report.failed) console.log(`  failed ${f.a} ~ ${f.b}: ${f.error}`);
	console.log(
		`same=${report.same} review=${report.review} different=${report.different} ` +
			`skipped=${report.skipped} failed=${report.failed.length} written=${report.written} ` +
			`inputTokens=${report.inputTokens}${args.dryRun ? ' (dry run)' : ''}`,
	);
}

/**
 * `graphx ask` — one Jev request turns the question into a typed call (search, list, or rank;
 * which node type; which metric), then it runs. Persisted `score:` metrics are offered too.
 */
async function runAsk(argv: string[]): Promise<void> {
	const args = parseAskArgs(argv);
	const cfg = await loadConfig(args.config);
	const graph = await openGraph(cfg);
	const scored = await graph.raw.execute('SELECT DISTINCT metric FROM node_scores');
	const metrics = Object.fromEntries(
		scored.rows.map((r) => [String(r.metric), `The ${String(r.metric)} score`]),
	);
	const { plan, rows } = await askGraph(graph, args.question, { limit: args.limit, metrics });
	console.log(
		`plan: ${plan.op}${plan.type ? ` ${plan.type}` : ''}${plan.metric ? ` by ${plan.metric}` : ''} ` +
			`(confidence ${plan.confidence.toFixed(2)}, type ${plan.typeConfidence.toFixed(2)})`,
	);
	if (rows === null) {
		console.log('not confident enough to run it — rephrase, or be specific about what to find');
		return;
	}
	for (const r of rows) {
		const label = Object.values(r.data as Record<string, unknown>).find(
			(v) => typeof v === 'string' && v,
		);
		console.log(
			`  ${r.type.padEnd(12)} ${String(label ?? '')
				.slice(0, 60)
				.padEnd(60)} ${r.id}`,
		);
	}
	console.log(`${rows.length} row(s)`);
}

/** `graphx doctor` — the namespace's embedding model, width, counts, and staleness. */
async function runDoctor(argv: string[]): Promise<void> {
	const args = parseTriggersArgs(argv);
	const cfg = await loadConfig(args.config);
	const client = openDb(cfg);
	await init(client);
	const graph = new Graph(client, cfg.schema, { embedder: cfg.embedder, embedding: 'off' });
	const r = await graph.embeddingReport();
	const lines = [
		`namespace      ${namespaceOf(cfg)} (${cfg.db?.driver ?? 'libsql'})`,
		`stored model   ${r.stored ? `${r.stored.model}  dim=${r.stored.dim}` : 'none (init with an embedder)'}`,
		`configured     ${r.configured ? `${r.configured.model}${r.configured.dim ? `  dim=${r.configured.dim}` : ''}` : 'none'}`,
		`live nodes     ${r.liveNodes}`,
		`embedded       ${r.embedded}  (${r.vectors} vector rows)`,
		`unembedded     ${r.unembedded}`,
		`stale          ${r.stale}`,
	];
	if (r.stored && r.configured && r.stored.model !== r.configured.model) {
		lines.push(
			`\n! model mismatch — run \`graphx reembed\` to switch this namespace to ${r.configured.model}`,
		);
	} else if (r.stale > 0 || r.unembedded > 0) {
		lines.push(`\n! ${r.stale + r.unembedded} node(s) need embedding — run \`graphx reembed\``);
	}
	console.log(lines.join('\n'));
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

/** This package’s own version — used to pin the scaffold’s `graphx` dep. */
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
			`  bun install        # pulls graphx from npm\n` +
			`  bun run serve      # http://localhost:8899\n`,
	);
}

/** The scaffold's package.json, with the graphx dep pinned to `range`. */
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
				graphx: range,
				zod: '^4',
			},
		},
		null,
		2,
	)}\n`;
}

const SCAFFOLD_CONFIG = `import { defineConfig, defineGraphSchema, hashEmbed } from 'graphx';
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

// hashEmbed is a deterministic, model-free embedder for dev. For production, swap in a real
// model — e.g. \`openai('text-embedding-3-small')\` from 'graphx/embedders'. The width is
// probed from the model and recorded in the namespace; there is nothing to keep in sync.
export default defineConfig({
	schema,
	embedder: hashEmbed(),
	namespace: 'graphx',
});
`;

const SCAFFOLD_README = `# graphx app

\`\`\`sh
bun install              # pulls graphx from npm
bun run serve            # http://localhost:8899  (GET /demo, GET /docs, GET /openapi.json)
bun run ingest           # ingest ./vault into the graph
\`\`\`

Working against an unreleased graphx instead of npm? The source package uses the \`workspace:\`
protocol, so it can't be \`file:\`-linked — develop this app **inside the graphx repo**: add its
path to the repo's root \`package.json\` \`workspaces\` array, then \`bun install\` from the repo
root.

Edit \`graphx.config.ts\` to shape your graph. Point a \`graphx/react\` client at the server with
\`<GraphProvider bootstrap="/demo" fetch={...} />\`.
`;

// Invoke when run as a script
if (import.meta.main) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
