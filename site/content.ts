/**
 * The page model: composition, copy, section order, which captured example each section shows, and
 * the link table. No markup — render.ts owns that. Copy is authored here; examples are not. Every
 * `terminal()` / `snippet()` / `table()` below is resolved against the README's fenced blocks at
 * build time, and a reference that resolves to zero or two blocks fails the build.
 */

export const origin = 'https://graphx.sh';
export const repo = 'https://github.com/TimMikeladze/graphx';
export const npm = 'https://www.npmjs.com/package/graphx';

/** The one place an absolute URL is made, so head, sitemap, llms.txt and the card cannot disagree. */
export function url(pagePath = '/'): string {
	const clean = pagePath.replace(/index\.html$/, '').replace(/\.html$/, '');
	return origin + (clean.startsWith('/') ? clean : `/${clean}`);
}

export type Ref =
	/** A fenced block whose first line is `$ <command>` — a captured run. */
	| { kind: 'terminal'; command: string }
	/** A fenced block containing exactly this line, for blocks with no command. */
	| { kind: 'snippet'; line: string; label: string };

export const terminal = (command: string): Ref => ({ kind: 'terminal', command });
export const snippet = (line: string, label: string): Ref => ({ kind: 'snippet', line, label });

export type Demo =
	| { kind: 'code'; ref: Ref }
	/** One capability, several labelled instances side by side. `caption` is the option each shows. */
	| { kind: 'variants'; items: { ref: Ref; caption: string }[] }
	/** A set rendered as a table, read from the README table whose first header cell is `header`. */
	| { kind: 'table'; header: string };

export interface Capability {
	id: string;
	/** ≤ 6 words, sentence case, no full stop. */
	title: string;
	/** 1–3 sentences of inline markdown; must name the real option in `code`. */
	body: string;
	demo: Demo;
	/** One sentence between this section and the next, offering the adjacent thing. */
	aside?: string;
}

export type IconName = 'github' | 'x' | 'linkedin' | 'discord' | 'text';

/** Brand marks for the ecosystem band and the showcase avatar stack (simple-icons slugs, CC0). */
export type EcoName =
	| 'sqlite'
	| 'postgresql'
	| 'duckdb'
	| 'bun'
	| 'nodedotjs'
	| 'webassembly'
	| 'expo'
	| 'react'
	| 'reactquery'
	| 'zod'
	| 'hono'
	| 'openapiinitiative'
	| 'modelcontextprotocol'
	| 'ollama';

export interface LinkEntry {
	label: string;
	/** `repo` follows the repo variable rather than repeating a URL. */
	href: string;
	icon: IconName;
	where: ('header' | 'footer')[];
}

export const links: LinkEntry[] = [
	{ label: 'graphx on GitHub', href: 'repo', icon: 'github', where: ['header', 'footer'] },
	{ label: 'linesofcode on X', href: 'https://x.com/linesofcode', icon: 'x', where: ['header', 'footer'] },
	{
		label: 'linesofcode on LinkedIn',
		href: 'https://www.linkedin.com/in/tim-mikeladze',
		icon: 'linkedin',
		where: ['header', 'footer'],
	},
	{
		label: 'linesofcode on Discord',
		href: 'https://discord.com/users/linesofcode',
		icon: 'discord',
		where: ['footer'],
	},
	{ label: 'graphx.sh', href: origin, icon: 'text', where: ['footer'] },
	{ label: 'graphx on npm', href: npm, icon: 'text', where: ['footer'] },
];

export const page = {
	name: 'graphx',
	/** The <title> and og:title suffix. */
	tagline: 'temporal GraphRAG for TypeScript',
	h1: 'Temporal GraphRAG for TypeScript',
	/** Inline markdown. Three facts: what it is, what it is built on, who made it. */
	lede:
		'`graphx` is an open source temporal graph for TypeScript. Built on [Zod](https://zod.dev), typed end to end, ' +
		'and packed with retrieval, traversal and serving.',
	/** The description meta: the lede's first sentence, extended to be useful in a result list. */
	description:
		'graphx is an open source temporal graph for TypeScript. Define it once with Zod and get typed writes, history, retrieval, an HTTP API and MCP.',
	license: 'MIT',
	category: 'DeveloperApplication',
	year: 2026,
	credit:
		'graphx is built and maintained by linesofcode. It is MIT licensed, and the README in the repository is the documentation this site is generated from.',
};

/** The hero's audience switch. The humans command is read from the README install fence, not here. */
export const audience = {
	agents: `curl ${origin}/llms.txt`,
};

/** Under the hero: the input graphx reacts to (left) and the code that handles it (right). */
export const split = {
	input: { ref: terminal('bunx graphx new my-app'), label: 'terminal' },
	handler: { ref: snippet("export default defineConfig({ schema, embedder: hashEmbed(), namespace: 'graphx' });", 'graphx.config.ts'), label: 'graphx.config.ts' },
};

/**
 * Figures, each counted from the repository at build time — never typed here. graphx is pre-launch
 * (npm still serves the 2017 package under this name), so there are no download or star figures.
 */
export type FigureSource =
	/** Rows of the README table whose first header cell is `header`. */
	| { kind: 'table'; header: string }
	/** `###` headings under the README `##` section `section`. */
	| { kind: 'subsections'; section: string }
	/** Lines starting with `prefix` in the one README fence containing `line`. */
	| { kind: 'lines'; line: string; prefix: string }
	/** Keys of `dependencies` in packages/graphx/package.json. */
	| { kind: 'dependencies' };

export const figures: { label: string; source: FigureSource }[] = [
	{ label: 'Entry points, one package', source: { kind: 'table', header: 'Import' } },
	{ label: 'Server backends', source: { kind: 'subsections', section: 'Backends' } },
	{ label: 'CLI commands', source: { kind: 'lines', line: 'graphx doctor   [-c config]', prefix: 'graphx ' } },
	{ label: 'Runtime dependencies', source: { kind: 'dependencies' } },
];

export const ecosystem = {
	title: 'Runs where your data already is',
	lede:
		'SQLite and libSQL, Postgres with pgvector, DuckDB, bql.sh, SQLite WASM in a browser tab and Expo on a phone. Served through Hono and OpenAPI, typed by Zod, read by React Query and MCP clients.',
	marks: [
		{ name: 'sqlite', label: 'SQLite', href: 'https://sqlite.org' },
		{ name: 'postgresql', label: 'PostgreSQL', href: 'https://www.postgresql.org' },
		{ name: 'duckdb', label: 'DuckDB', href: 'https://duckdb.org' },
		{ name: 'bun', label: 'Bun', href: 'https://bun.sh' },
		{ name: 'nodedotjs', label: 'Node.js', href: 'https://nodejs.org' },
		{ name: 'webassembly', label: 'SQLite WASM in the browser', href: 'https://sqlite.org/wasm' },
		{ name: 'expo', label: 'Expo', href: 'https://expo.dev' },
		{ name: 'react', label: 'React', href: 'https://react.dev' },
		{ name: 'reactquery', label: 'TanStack Query', href: 'https://tanstack.com/query' },
		{ name: 'zod', label: 'Zod', href: 'https://zod.dev' },
		{ name: 'hono', label: 'Hono', href: 'https://hono.dev' },
		{ name: 'openapiinitiative', label: 'OpenAPI', href: 'https://www.openapis.org' },
		{ name: 'modelcontextprotocol', label: 'Model Context Protocol', href: 'https://modelcontextprotocol.io' },
		{ name: 'ollama', label: 'Ollama', href: 'https://ollama.com' },
	] satisfies { name: EcoName; label: string; href: string }[],
};

/** The three claims the design rests on — each one enforced by code or the test suite. */
export const principles = [
	{ title: 'One schema, no codegen', body: 'Writes, routes, hooks and MCP tools infer from one `Schema` type. There is no generate step to forget.' },
	{ title: 'Nothing is erased', body: 'A delete closes a `valid_to` interval. Any read takes `asOf` and reconstructs that instant exactly.' },
	{ title: 'One contract everywhere', body: 'Every type, route and payload is identical across backends. The README examples compile against the build.' },
];

/** The tabbed showcase: each tab is a different resolved README block. */
export const showcase = {
	title: 'Write it, query it, serve it',
	body:
		'The same `Graph` object writes, reads and walks. `match` compiles a typed pattern to one SQL statement, and `createApp` serves all of it with a generated OpenAPI contract.',
	supports: ['sqlite', 'postgresql', 'duckdb', 'bun', 'expo'] satisfies EcoName[],
	more: '+ browser and bql.sh',
	tabs: [
		{ label: 'Write', ref: snippet("await g.addEdge({ rel: 'deployedAt', src: gw.id, dst: site.id });", 'app.ts') },
		{ label: 'Query', ref: snippet('const rows = await q.run(); // rows[0].g.data, rows[0].a.data', 'query.ts') },
		{ label: 'Serve', ref: snippet("openapi: { title: 'iot-fleet', servers: [{ url: 'http://localhost:8899' }] },", 'server.ts') },
		{ label: 'Production', ref: snippet('control, // the shared registry of tenants, projects and memberships', 'prod.ts') },
	],
};

export const buildToday = {
	title: 'Build a temporal graph today',
	scaffold: terminal('bunx graphx new my-app'),
};

/** Guide cards: each links to its README section on the reference page and previews its code. */
export const guides = [
	{ title: 'Time travel', body: 'History, diffs and the change feed.', href: '/reference#time-travel', ref: snippet('await timeline(db, { buckets: 120 }); // change-point extent + density histogram + snap ticks', 'time.ts') },
	{ title: 'Ingest a vault', body: 'Markdown and wikilinks into typed edges.', href: '/reference#ingest', ref: snippet("import { ingestDir, watchDir } from 'graphx/ingest';", 'ingest.ts') },
	{ title: 'Judgments with Jev', body: 'Rerank, dedupe and type links by meaning.', href: '/reference#judgments-with-jev', ref: snippet("const jev = createJev(); // model 'jev-latest'; retries 429, 529 and 5xx with backoff", 'jev.ts') },
];

/** Mega-footer columns. `href` starting with `/` is this site; `isNew` is the release date (ISO). */
export const footerColumns: { title: string; links: { label: string; href: string; isNew?: string }[] }[] = [
	{
		title: 'graphx',
		links: [
			{ label: 'Home', href: '/' },
			{ label: 'Reference', href: '/reference' },
			{ label: 'npm', href: npm },
			{ label: 'Changelog', href: `${repo}/commits/main` },
		],
	},
	{
		title: 'Backends',
		links: [
			{ label: 'libSQL and SQLite', href: '/reference#libsql-and-sqlite-default' },
			{ label: 'Postgres', href: '/reference#postgres' },
			{ label: 'DuckDB', href: '/reference#duckdb-over-an-object-store' },
			{ label: 'bql.sh', href: '/reference#bqlsh', isNew: '2026-09-25' },
			{ label: 'Local-first', href: '/reference#local-first-runtimes' },
		],
	},
	{
		title: 'Serve',
		links: [
			{ label: 'HTTP and OpenAPI', href: '/reference#serving-over-http' },
			{ label: 'React', href: '/reference#react' },
			{ label: 'MCP', href: '/reference#mcp' },
			{ label: 'Access control', href: '/reference#access-control' },
		],
	},
	{
		title: 'Learn',
		links: [
			{ label: 'Quickstart', href: '/reference#quickstart' },
			{ label: 'Examples', href: '/reference#examples' },
			{ label: 'CLI', href: '/reference#cli' },
			{ label: 'Contributing', href: '/reference#contributing' },
		],
	},
	{
		title: 'Agents',
		links: [
			{ label: 'llms.txt', href: '/llms.txt' },
			{ label: 'AGENTS.md', href: '/AGENTS.md' },
			{ label: 'Page as Markdown', href: '/index.md' },
		],
	},
	{
		title: 'Legal',
		links: [{ label: 'MIT License', href: `${repo}/blob/main/LICENSE` }],
	},
];

export const capabilities: Capability[] = [
	{
		id: 'one-schema',
		title: 'One schema, no codegen',
		body:
			'Describe nodes and edges with Zod objects in `defineGraphSchema`. Typed writes, pattern matching, HTTP routes, hooks and MCP tools are all inferred from that one `Schema` type, so there is no generate step to run.',
		demo: { kind: 'code', ref: snippet('type Schema = typeof schema;', 'graphx.config.ts') },
	},
	{
		id: 'bitemporal',
		title: 'Every write is bitemporal',
		body:
			'Versions carry `valid_from` and `valid_to`, so a delete closes an interval instead of erasing a row. Pass `asOf` to any read to see the graph as it stood at that instant.',
		demo: { kind: 'code', ref: terminal('bun run examples/basic-demo.ts') },
		aside: 'Want the change stream instead? Tail `changeFeed`, or mount `useChangeFeedSync` from `graphx/react`.',
	},
	{
		id: 'retrieval',
		title: 'Vector, text and graph together',
		body:
			'Call `hybridRetrieve` to fuse vector and full-text results with reciprocal rank fusion, then walk out from the seeds along edges valid at that time. Each row says which leg matched it in `via`.',
		demo: { kind: 'code', ref: snippet('rrfK: 60,', 'retrieve.ts') },
	},
	{
		id: 'pattern-matching',
		title: 'Typed pattern matching',
		body:
			'Chain `match(schema, db)` with `.node()`, `.out()` and `.in()`. It compiles to one SQL statement and returns rows typed per alias, with `page()` for keyset pagination over the same pattern.',
		demo: { kind: 'code', ref: snippet("const page = await q.page({ limit: 100 });", 'match.ts') },
	},
	{
		id: 'embeddings',
		title: 'The graph owns embedding',
		body:
			'Every write embeds through the graph’s `embedder`, and re-embeds only when the input hash changes. Run `graphx doctor` to see the stored model, its width and how many nodes are stale.',
		demo: { kind: 'code', ref: terminal('graphx doctor') },
	},
	{
		id: 'backends',
		title: 'Backend is configuration',
		body:
			'Pick a store with the `driver` option on `getDb`. Every public type, method, route and payload is identical across libSQL, Postgres with pgvector and DuckDB over an object store.',
		demo: {
			kind: 'variants',
			items: [
				{ ref: snippet("const db = getDb('acme__alpha'); // file:acme__alpha.db", 'libsql'), caption: 'default, no driver' },
				{ ref: snippet("connectionString: 'postgresql://user:pass@host:5432/graphx',", 'postgres'), caption: "driver: 'postgres'" },
				{ ref: snippet("const db = getDb('acme__alpha', { driver: 'duckdb' });", 'duckdb'), caption: "driver: 'duckdb'" },
			],
		},
	},
	{
		id: 'runtimes',
		title: 'Runs in browsers and phones',
		body:
			'Import from `graphx/core` and hand it a `DbClient`. `openLocalDb`, `openBrowserDb` and `openExpoDb` each own their connection and verify the pragmas they depend on, so a host without durable storage fails loudly.',
		demo: {
			kind: 'variants',
			items: [
				{ ref: snippet("import { openLocalDb, openMemoryDb } from 'graphx/local';", 'node.ts'), caption: 'graphx/local, Node or Bun' },
				{ ref: snippet("import { openBrowserDb } from 'graphx/browser';", 'browser.ts'), caption: 'graphx/browser, SQLite WASM on OPFS' },
				{ ref: snippet("import { openExpoDb } from 'graphx/expo';", 'expo.ts'), caption: 'graphx/expo, iOS and Android' },
			],
		},
		aside: 'Want it over the network instead? Serve the same graph with `createApp`.',
	},
	{
		id: 'http',
		title: 'Typed HTTP with OpenAPI',
		body:
			'Pass your schema to `createApp` and get typed routes, a generated `GET /openapi.json` and an interactive reference at `/docs`. Every route sits under `/t/{tenant}/p/{project}`, so tenant isolation holds by construction.',
		demo: { kind: 'code', ref: snippet('// Typed routes + GET /openapi.json + an interactive reference at /docs', 'server.ts') },
	},
	{
		id: 'react',
		title: 'Hooks with no generated client',
		body:
			'`createGraphHooks<Schema>()` types every React Query hook from the schema type alone. The browser bundle carries no SDK runtime, and `useChangeFeedSync` invalidates exactly the keys that moved.',
		demo: { kind: 'code', ref: snippet('const g = createGraphHooks<Schema>();', 'hooks.tsx') },
	},
	{
		id: 'mcp',
		title: 'An MCP server for free',
		body:
			'Run `graphx mcp` and every serving route becomes a tool over stdio, validated against your `graphx.config.ts`. Add `--read-only` to expose only the read tools.',
		demo: { kind: 'code', ref: snippet('"mcpServers": {', 'mcp.json') },
	},
	{
		id: 'access-control',
		title: 'Access control in the graph',
		body:
			'`graphx/auth` stores relationship tuples as edges, so `auth.check` is a temporal graph query. Pass `asOf` to ask what a user could do last week.',
		demo: { kind: 'code', ref: snippet('const auth = new Auth(g, model);', 'auth.ts') },
	},
	{
		id: 'entry-points',
		title: 'One package, many entry points',
		body:
			'Everything is a subpath of `graphx`, and each is a separate entry point. An optional peer such as `pg` only lands on your import path if you import `graphx/pg`.',
		demo: { kind: 'table', header: 'Import' },
	},
];

/** Three counted columns. Authored judgement, each item backed by a sentence in the README. */
export const boundaries = {
	title: 'Boundaries',
	intro:
		'Three lists, counted. The first is exercised by the test suite, the second is opinion, and the third is what you should not assume.',
	titles: { holds: 'What holds', judgements: 'What is a judgement', missing: 'What is not here yet' },
	holds: [
		'Every TypeScript block in the README is compiled against the built package by the test suite.',
		'History is append-only: a delete closes a version, and `asOf` reads reconstruct the graph exactly.',
		'Tenant isolation is by route construction, not by a `WHERE` clause.',
		'A namespace refuses a different embedding model until `graphx reembed` switches it.',
	],
	judgements: [
		'`hashEmbed` is lexical and model-free. It suits tests and demos; retrieval quality in production is your embedder’s.',
		'Delivery of triggers is at-least-once, so actions must be idempotent. That is a design choice, not a bug to be fixed.',
		'Calling it “temporal GraphRAG” is our description of retrieve-then-walk, not a benchmarked claim.',
	],
	missing: [
		'No benchmark figures on this page. `bun run bench` exists, but the README holds no captured run to reference.',
		'DuckDB allows one writer process per namespace; two rewriting the same table raise `SnapshotConflictError`.',
		'`Graph.atomic` needs a namespace with no embeddings, and browser writers can still hit `SQLITE_BUSY`.',
		'The admin SPA is not published. It runs from the repository.',
	],
};

export const start = {
	title: 'Start with a scaffold',
	body:
		'Run `graphx new` to write a runnable `graphx.config.ts`, then `bun run serve`. Contributing to graphx itself runs the same gate CI does.',
	install: terminal('bunx graphx new my-app'),
	gate: snippet('bun run type-check', 'contributing'),
};

/** Sections of the README are the reference page; this is only its intro line. */
export const reference = {
	title: 'Reference',
	intro: 'The whole README, in full. It is the documentation, and this page is generated from it.',
	description: 'The complete graphx documentation: install, schema, writing, retrieval, time travel, serving, backends and the CLI.',
};

/** For AGENTS.md: the option table and the three mistakes that break it. Authored; each is in the README. */
export const agents = {
	summary: 'Use graphx to store, query and serve a temporal graph from TypeScript. Import from the `graphx` package and its subpaths.',
	minimal: [
		snippet("export default defineConfig({ schema, embedder: hashEmbed(), namespace: 'graphx' });", 'graphx.config.ts'),
		snippet('const g = new Graph(db, schema, { embedder });', 'app.ts'),
	],
	options: [
		['asOf', 'epoch ms on any read', 'Point-in-time view'],
		['single: true', 'edge definition', 'Single-valued rel; each addEdge closes the previous live one'],
		['expectedRevision', 'update option', 'Concurrent writer surfaces as RevisionConflict'],
		["embedding: 'lazy' | 'off'", 'Graph option', 'Defer embedding to an embedTrigger, or never embed'],
		['limits', 'read option', 'Row cap, fan-out guard and timeout'],
		['driver', 'getDb config', "'postgres' or 'duckdb'; default is libSQL"],
	],
	mistakes: [
		"Importing `getDb` with `driver: 'postgres'` or `'duckdb'` without `import 'graphx/pg'` / `import 'graphx/duck'` first. The adapter is a side effect, and `getDb` throws without it.",
		'Switching the embedder model without running `graphx reembed`. The namespace records the model and width and refuses a different one.',
		'Calling `journey` without `from` (epoch ms). It is required, and only edges valid at each step are followed.',
	],
};
