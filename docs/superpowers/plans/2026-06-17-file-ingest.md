# File-Ingest Static Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `ingest` package that turns a local YAML/markdown vault into a graphx graph (1 file = 1 node, links = edges), with incremental bitemporal re-sync keyed on a content hash.

**Architecture:** `ingestDir(opts)` is a pure function over a structural graph interface. It discovers + parses files, reads the live graph's identity map via `graph.raw`, then upserts: new files → `addNode`, content-changed files → `updateNode` (new temporal version), unchanged → skip. Touched files then reconcile their out-edges. Identity key = relative POSIX path stored in the node `uri` column (`file:<path>`); change detection = `content_hash` column. Embeddings populated on add/change.

**Tech Stack:** Bun + `bun:test`; TypeScript (ESM, `.ts` extension imports, `isolatedDeclarations`); `gray-matter` for frontmatter; `core` graphx as a peer (type-only at compile, supplied by the consumer at runtime).

## Global Constraints

- Runtime is **Bun**; tests use `bun:test`. Source imports use **`.ts` extensions** (`allowImportingTsExtensions`) and `verbatimModuleSyntax` — type-only imports MUST use `import type`.
- `tsconfig` sets **`isolatedDeclarations: true`** — every **exported** symbol needs an explicit type annotation. Keep internal helpers **unexported** to avoid this.
- `core` is **type-only** in `ingest` source (erased at runtime by `verbatimModuleSyntax`). `ingestDir` operates only on the passed-in graph object — it never constructs a `Graph` or calls a `core` runtime function.
- **Identity** lives in node columns, never `props`: key → `uri` column as `file:<key>`; hash → `content_hash` column. (`z.object()` strips unknown `props` keys by default.) Read both back via `graph.raw` from the live `nodes` view.
- **Relation** for links is the literal `links_to`. The consumer's schema must declare the kinds used + the `links_to` edge. Unknown kind / rejected edge / unresolved link → recorded in `result.skipped`, never thrown.
- **No node deletion** in v1 (graphx has no public `deleteNode`). Deleted files leave stale live nodes; renames create a new node + orphan.
- Dual-backend tests run via `../../core/test/harness.ts` + `GRAPHX_TEST_DRIVER`. Anywhere vector ranking matters, assert **set membership, not order**.
- Verify after each task: `bun test` (libSQL) AND `GRAPHX_TEST_DRIVER=postgres bun test` AND `bun run type-check`. The PG container `graphx-pgtest` (pgvector/pgvector:pg16, port 5455) must be running.

---

### Task 1: Scaffold the `ingest` package

**Files:**
- Create: `packages/ingest/package.json`
- Create: `packages/ingest/tsconfig.json`
- Create: `packages/ingest/src/types.ts`
- Create: `packages/ingest/src/index.ts`
- Modify: `bunup.config.ts`

**Interfaces:**
- Produces: the public types `ParsedFile`, `IngestOptions<S>`, `IngestResult` and a stub `ingestDir` (real body lands in Task 6/7). Later tasks import these from `../src/types.ts` and `../src/index.ts`.

- [ ] **Step 1: Create `packages/ingest/package.json`**

```json
{
	"name": "ingest",
	"version": "0.1.0",
	"description": "Ingest a YAML/markdown vault into a graphx graph",
	"license": "MIT",
	"type": "module",
	"module": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"import": {
				"types": "./dist/index.d.ts",
				"default": "./dist/index.js"
			}
		},
		"./package.json": "./package.json"
	},
	"scripts": {
		"type-check": "tsc --noEmit"
	},
	"dependencies": {
		"gray-matter": "^4.0.3"
	},
	"peerDependencies": {
		"core": "workspace:*",
		"typescript": ">=4.5.0"
	},
	"peerDependenciesMeta": {
		"typescript": {
			"optional": true
		}
	},
	"devDependencies": {
		"@types/node": "^25.9.1",
		"core": "workspace:*",
		"zod": "^4.4.3"
	}
}
```

- [ ] **Step 2: Create `packages/ingest/tsconfig.json`**

`esModuleInterop` is required for the `gray-matter` default import (it is a CJS `export =` module).

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"declaration": true,
		"isolatedDeclarations": true,
		"esModuleInterop": true,
		"types": ["node"]
	},
	"include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/ingest/src/types.ts`**

```ts
import type { EmbedFn, Graph, GraphSchema } from 'core';

/** A parsed source file. `key` is the relative POSIX path from the vault root. */
export interface ParsedFile {
	key: string;
	/** Full raw file contents (the hash input). */
	raw: string;
	/** sha256 hex of `raw`. */
	hash: string;
	/** Parsed YAML frontmatter (empty object if none). */
	frontmatter: Record<string, unknown>;
	/** Markdown body, frontmatter stripped (empty string for pure-YAML files). */
	body: string;
}

export interface IngestOptions<S extends GraphSchema> {
	/** Local vault root. */
	dir: string;
	/** Target graph, already bound to its DbClient + schema. */
	graph: Graph<S>;
	/** Embedding function — required (embeddings-on scope). */
	embed: EmbedFn;
	/** File extensions to include (lowercase, with dot). Default: .md/.markdown/.yml/.yaml */
	include?: string[];
	/** Override kind resolution. Default: frontmatter.kind ?? top-level folder name. */
	kindOf?: (file: ParsedFile) => string | undefined;
}

export interface IngestResult {
	added: number;
	updated: number;
	unchanged: number;
	edgesAdded: number;
	edgesClosed: number;
	/** Files/links skipped, with a reason (no kind, schema reject, unresolved link). */
	skipped: Array<{ key: string; reason: string }>;
}
```

- [ ] **Step 4: Create `packages/ingest/src/index.ts` (stub)**

```ts
import type { GraphSchema } from 'core';
import type { IngestOptions, IngestResult } from './types.ts';

export type { IngestOptions, IngestResult, ParsedFile } from './types.ts';

/** Ingest a local YAML/markdown vault into `opts.graph`. Implemented in later tasks. */
export async function ingestDir<S extends GraphSchema>(
	_opts: IngestOptions<S>,
): Promise<IngestResult> {
	throw new Error('ingestDir: not implemented');
}
```

- [ ] **Step 5: Register the package with bunup — edit `bunup.config.ts`**

Add an `ingest` entry to the `defineWorkspace([...])` array (after the `core` entry):

```ts
	{
		name: 'ingest',
		root: 'packages/ingest',
	},
```

- [ ] **Step 6: Install + verify the package is wired**

Run: `bun install`
Then: `bun run type-check`
Expected: `core`, `admin`, `auth`, **and `ingest`** each print `type-check: Exited with code 0`.

- [ ] **Step 7: Verify it builds**

Run: `bun run build`
Expected: build output lists `ingest  src/index.ts` and emits `packages/ingest/dist/index.js` + `index.d.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/ingest bunup.config.ts package.json bun.lock
git commit -m "feat(ingest): scaffold package (types + stub ingestDir)"
```

---

### Task 2: `parseFile`

**Files:**
- Create: `packages/ingest/src/parse.ts`
- Test: `packages/ingest/test/parse.test.ts`

**Interfaces:**
- Consumes: `ParsedFile` from `./types.ts`.
- Produces: `export function parseFile(key: string, raw: string): ParsedFile`.

- [ ] **Step 1: Write the failing test — `packages/ingest/test/parse.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { parseFile } from '../src/parse.ts';

test('parseFile: markdown splits frontmatter and body, hashes raw', () => {
	const raw = '---\nkind: note\ntitle: Hello\n---\nbody text\n';
	const f = parseFile('notes/a.md', raw);
	expect(f.key).toBe('notes/a.md');
	expect(f.frontmatter).toEqual({ kind: 'note', title: 'Hello' });
	expect(f.body.trim()).toBe('body text');
	expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
});

test('parseFile: pure YAML file becomes all-frontmatter, empty body', () => {
	const f = parseFile('people/bob.yaml', 'kind: person\nname: Bob\n');
	expect(f.frontmatter).toEqual({ kind: 'person', name: 'Bob' });
	expect(f.body).toBe('');
});

test('parseFile: same bytes hash identically, different bytes differ', () => {
	expect(parseFile('a.md', 'x').hash).toBe(parseFile('a.md', 'x').hash);
	expect(parseFile('a.md', 'x').hash).not.toBe(parseFile('a.md', 'y').hash);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/ingest/test/parse.test.ts`
Expected: FAIL — `Cannot find module '../src/parse.ts'`.

- [ ] **Step 3: Implement `packages/ingest/src/parse.ts`**

```ts
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { ParsedFile } from './types.ts';

const YAML_EXT = /\.ya?ml$/i;

/**
 * Parse a source file into frontmatter + body. Markdown files use gray-matter's
 * `---` frontmatter; pure-YAML files are wrapped so their whole content is parsed as
 * frontmatter (body empty). `hash` is sha256 of the raw bytes (the change-detection key).
 */
export function parseFile(key: string, raw: string): ParsedFile {
	const isYaml = YAML_EXT.test(key);
	const src = isYaml ? `---\n${raw}\n---\n` : raw;
	const parsed = matter(src);
	return {
		key,
		raw,
		hash: createHash('sha256').update(raw).digest('hex'),
		frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
		body: isYaml ? '' : parsed.content,
	};
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun test packages/ingest/test/parse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/parse.ts packages/ingest/test/parse.test.ts
git commit -m "feat(ingest): parseFile (frontmatter/body/hash)"
```

---

### Task 3: `extractLinks`

**Files:**
- Create: `packages/ingest/src/links.ts`
- Test: `packages/ingest/test/links.test.ts`

**Interfaces:**
- Produces: `export interface Link { kind: 'wiki' | 'path'; target: string }` and `export function extractLinks(body: string): Link[]`.

- [ ] **Step 1: Write the failing test — `packages/ingest/test/links.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { extractLinks } from '../src/links.ts';

test('extractLinks: wikilinks (with alias stripped)', () => {
	expect(extractLinks('see [[Bob]] and [[notes/c|C]]')).toEqual([
		{ kind: 'wiki', target: 'Bob' },
		{ kind: 'wiki', target: 'notes/c' },
	]);
});

test('extractLinks: relative markdown links, external/anchor ignored', () => {
	expect(
		extractLinks('[x](./b.md) [y](../d.md) [ext](https://e.com) [a](#frag)'),
	).toEqual([
		{ kind: 'path', target: './b.md' },
		{ kind: 'path', target: '../d.md' },
	]);
});

test('extractLinks: none', () => {
	expect(extractLinks('plain text, no links')).toEqual([]);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/ingest/test/links.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/ingest/src/links.ts`**

```ts
/** A link found in a node body. `wiki` resolves by basename; `path` by relative path. */
export interface Link {
	kind: 'wiki' | 'path';
	target: string;
}

const WIKILINK = /\[\[([^\]]+)\]\]/g;
const MDLINK = /\[[^\]]*\]\(([^)]+)\)/g;

/** Extract `[[wikilinks]]` and relative `[text](path)` links; skip external/anchor links. */
export function extractLinks(body: string): Link[] {
	const out: Link[] = [];
	for (const m of body.matchAll(WIKILINK)) {
		const target = m[1]!.split('|')[0]!.trim();
		if (target) out.push({ kind: 'wiki', target });
	}
	for (const m of body.matchAll(MDLINK)) {
		const target = m[1]!.trim();
		if (!target || target.startsWith('http://') || target.startsWith('https://')) continue;
		if (target.startsWith('#')) continue;
		out.push({ kind: 'path', target });
	}
	return out;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun test packages/ingest/test/links.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/links.ts packages/ingest/test/links.test.ts
git commit -m "feat(ingest): extractLinks (wikilinks + relative md links)"
```

---

### Task 4: `buildPathIndex` + `resolveLink`

**Files:**
- Create: `packages/ingest/src/resolve.ts`
- Test: `packages/ingest/test/resolve.test.ts`

**Interfaces:**
- Consumes: `Link` from `./links.ts`.
- Produces: `export interface PathIndex { byPath: Set<string>; byBasename: Map<string, string[]> }`, `export function buildPathIndex(keys: string[]): PathIndex`, `export function resolveLink(link: Link, fromKey: string, index: PathIndex): string | null`.

- [ ] **Step 1: Write the failing test — `packages/ingest/test/resolve.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { buildPathIndex, resolveLink } from '../src/resolve.ts';

const index = buildPathIndex(['notes/a.md', 'notes/b.md', 'people/bob.yaml']);

test('resolveLink: relative path link resolves against the source file dir', () => {
	expect(resolveLink({ kind: 'path', target: './b.md' }, 'notes/a.md', index)).toBe('notes/b.md');
	expect(resolveLink({ kind: 'path', target: '../people/bob.yaml' }, 'notes/a.md', index)).toBe(
		'people/bob.yaml',
	);
});

test('resolveLink: wikilink resolves by unique basename (ext/case-insensitive)', () => {
	expect(resolveLink({ kind: 'wiki', target: 'b' }, 'notes/a.md', index)).toBe('notes/b.md');
	expect(resolveLink({ kind: 'wiki', target: 'Bob' }, 'notes/a.md', index)).toBe('people/bob.yaml');
});

test('resolveLink: missing target and ambiguous basename return null', () => {
	expect(resolveLink({ kind: 'path', target: './missing.md' }, 'notes/a.md', index)).toBeNull();
	const dup = buildPathIndex(['x/a.md', 'y/a.md']);
	expect(resolveLink({ kind: 'wiki', target: 'a' }, 'x/a.md', dup)).toBeNull();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/ingest/test/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/ingest/src/resolve.ts`**

```ts
import { basename, dirname, extname, join } from 'node:path/posix';
import type { Link } from './links.ts';

export interface PathIndex {
	byPath: Set<string>;
	byBasename: Map<string, string[]>;
}

function baseKey(key: string): string {
	return basename(key, extname(key)).toLowerCase();
}

/** Index keys for link resolution: exact-path set + basename → keys (for wikilinks). */
export function buildPathIndex(keys: string[]): PathIndex {
	const byPath = new Set<string>(keys);
	const byBasename = new Map<string, string[]>();
	for (const key of keys) {
		const b = baseKey(key);
		const list = byBasename.get(b);
		if (list) list.push(key);
		else byBasename.set(b, [key]);
	}
	return { byPath, byBasename };
}

/** Resolve a link to a vault key, or `null` if unresolved/ambiguous. */
export function resolveLink(link: Link, fromKey: string, index: PathIndex): string | null {
	if (link.kind === 'path') {
		const resolved = join(dirname(fromKey), link.target);
		return index.byPath.has(resolved) ? resolved : null;
	}
	const hits = index.byBasename.get(baseKey(link.target));
	return hits && hits.length === 1 ? hits[0]! : null;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun test packages/ingest/test/resolve.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/resolve.ts packages/ingest/test/resolve.test.ts
git commit -m "feat(ingest): path index + link resolution"
```

---

### Task 5: `discover`

**Files:**
- Create: `packages/ingest/src/discover.ts`
- Test: `packages/ingest/test/discover.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_INCLUDE: string[]` and `export async function discover(dir: string, include: string[]): Promise<string[]>` (sorted relative POSIX keys).

- [ ] **Step 1: Write the failing test — `packages/ingest/test/discover.test.ts`**

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DEFAULT_INCLUDE, discover } from '../src/discover.ts';

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'gx-discover-'));
	await mkdir(join(dir, 'notes'), { recursive: true });
	await writeFile(join(dir, 'a.md'), 'a');
	await writeFile(join(dir, 'notes', 'b.markdown'), 'b');
	await writeFile(join(dir, 'notes', 'c.yaml'), 'c');
	await writeFile(join(dir, 'ignore.txt'), 'nope');
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

test('discover: returns sorted POSIX keys for included extensions only', async () => {
	expect(await discover(dir, DEFAULT_INCLUDE)).toEqual([
		'a.md',
		'notes/b.markdown',
		'notes/c.yaml',
	]);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/ingest/test/discover.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/ingest/src/discover.ts`**

```ts
import { readdir } from 'node:fs/promises';
import { sep } from 'node:path';
import { extname } from 'node:path/posix';

export const DEFAULT_INCLUDE: string[] = ['.md', '.markdown', '.yml', '.yaml'];

/** Recursively list files under `dir` whose extension is in `include`, as sorted POSIX keys. */
export async function discover(dir: string, include: string[]): Promise<string[]> {
	const exts = new Set(include.map((e) => e.toLowerCase()));
	const entries = await readdir(dir, { recursive: true });
	return entries
		.map((e) => e.split(sep).join('/'))
		.filter((e) => exts.has(extname(e).toLowerCase()))
		.sort();
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun test packages/ingest/test/discover.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/discover.ts packages/ingest/test/discover.test.ts
git commit -m "feat(ingest): recursive file discovery by extension"
```

---

### Task 6: `ingestDir` — node reconciliation (add / idempotent / update)

**Files:**
- Create: `packages/ingest/src/ingest.ts`
- Modify: `packages/ingest/src/index.ts` (re-export from `./ingest.ts`, drop the stub)
- Test: `packages/ingest/test/ingest.test.ts`

**Interfaces:**
- Consumes: `parseFile` (Task 2), `discover`/`DEFAULT_INCLUDE` (Task 5), types (Task 1).
- Produces: `export async function ingestDir<S extends GraphSchema>(opts: IngestOptions<S>): Promise<IngestResult>`. Edge reconciliation is added in Task 7 — this task leaves `edgesAdded`/`edgesClosed` at 0.

- [ ] **Step 1: Write the failing test — `packages/ingest/test/ingest.test.ts`**

This test uses `core`'s source directly (relative imports) plus the dual-backend harness, exactly like `core`'s own tests.

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../core/src/define-graph-schema.ts';
import type { DbClient } from '../../core/src/dialect.ts';
import { Graph } from '../../core/src/graph.ts';
import type { EmbedFn } from '../../core/src/retrieve.ts';
import { init } from '../../core/src/schema.ts';
import { makeTestDb } from '../../core/test/harness.ts';
import { ingestDir } from '../src/index.ts';

const SCHEMA = defineGraphSchema({
	nodes: { note: z.object({ title: z.string().optional() }).passthrough() },
	edges: { links_to: { from: 'note', to: 'note' } },
});

const embed: EmbedFn = async () => [1, 0, 0, 0];

async function graph(): Promise<{ g: Graph<typeof SCHEMA>; client: DbClient }> {
	const client = makeTestDb().client;
	await init(client, 4);
	return { g: new Graph(client, SCHEMA), client };
}

async function vault(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'gx-ingest-'));
	for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
	return dir;
}

test('ingestDir: first run adds a node per file', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\ntitle: A\n---\nalpha',
		'b.md': '---\nkind: note\ntitle: B\n---\nbeta',
	});
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(2);
	expect(res.updated).toBe(0);
	const rows = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	expect(Number(rows.rows[0]!.c)).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: re-running an unchanged vault is a no-op', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\nkind: note\n---\nalpha' });
	await ingestDir({ dir, graph: g, embed });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: editing a file creates a new version (history preserved)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\nkind: note\n---\nv1' });
	await ingestDir({ dir, graph: g, embed });
	await writeFile(join(dir, 'a.md'), '---\nkind: note\n---\nv2');
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
	const versions = await client.execute({
		sql: 'SELECT COUNT(*) AS c FROM node_versions WHERE uri = ?',
		args: ['file:a.md'],
	});
	expect(Number(versions.rows[0]!.c)).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a file with no resolvable kind is skipped', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': 'no frontmatter here' });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(0);
	expect(res.skipped).toEqual([{ key: 'a.md', reason: 'no kind' }]);
	await rm(dir, { recursive: true, force: true });
	client.close();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/ingest/test/ingest.test.ts`
Expected: FAIL — `ingestDir: not implemented` (the Task 1 stub).

- [ ] **Step 3: Implement `packages/ingest/src/ingest.ts`**

`LooseGraph` is the structural slice of `Graph` that `ingestDir` calls, with loosened (non-generic) signatures — the file's dynamic `kind`/`props` can't satisfy `Graph`'s literal-kind generics, so the typed graph is cast to it once.

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphSchema } from 'core';
import { DEFAULT_INCLUDE, discover } from './discover.ts';
import { parseFile } from './parse.ts';
import type { IngestOptions, IngestResult, ParsedFile } from './types.ts';

/** The structural, non-generic slice of `Graph` that ingest drives. */
interface LooseGraph {
	addNode(n: {
		kind: string;
		body?: string;
		uri?: string;
		props: Record<string, unknown>;
		content_hash?: string;
		emb?: number[];
	}): Promise<{ id: string }>;
	updateNode(
		id: string,
		patch: {
			kind?: string;
			body?: string;
			props?: Record<string, unknown>;
			content_hash?: string;
			emb?: number[];
		},
	): Promise<void>;
	addEdge(e: { rel: string; src: string; dst: string }): Promise<{ id: string }>;
	deleteEdge(id: string): Promise<void>;
	raw: {
		execute(stmt: {
			sql: string;
			args: unknown[];
		}): Promise<{ rows: Array<Record<string, unknown>> }>;
	};
}

const KEY_PREFIX = 'file:';

interface LiveEntry {
	id: string;
	hash: string;
}

/** Read the live identity map (key → node id + hash) from the `nodes` view via raw SQL. */
async function loadLiveMap(g: LooseGraph): Promise<Map<string, LiveEntry>> {
	const map = new Map<string, LiveEntry>();
	const r = await g.raw.execute({
		sql: `SELECT id, uri, content_hash FROM nodes WHERE uri LIKE '${KEY_PREFIX}%'`,
		args: [],
	});
	for (const row of r.rows) {
		const uri = String(row.uri);
		map.set(uri.slice(KEY_PREFIX.length), {
			id: String(row.id),
			hash: row.content_hash == null ? '' : String(row.content_hash),
		});
	}
	return map;
}

function resolveKind(file: ParsedFile, kindOf?: (f: ParsedFile) => string | undefined): string | undefined {
	const explicit = kindOf?.(file);
	if (explicit) return explicit;
	if (typeof file.frontmatter.kind === 'string') return file.frontmatter.kind;
	const slash = file.key.indexOf('/');
	return slash > 0 ? file.key.slice(0, slash) : undefined;
}

/** Frontmatter minus the reserved `kind` key. */
function toProps(frontmatter: Record<string, unknown>): Record<string, unknown> {
	const { kind: _kind, ...rest } = frontmatter;
	return rest;
}

export async function ingestDir<S extends GraphSchema>(
	opts: IngestOptions<S>,
): Promise<IngestResult> {
	const g = opts.graph as unknown as LooseGraph;
	const include = opts.include ?? DEFAULT_INCLUDE;
	const result: IngestResult = {
		added: 0,
		updated: 0,
		unchanged: 0,
		edgesAdded: 0,
		edgesClosed: 0,
		skipped: [],
	};

	const keys = await discover(opts.dir, include);
	const files: ParsedFile[] = [];
	for (const key of keys) {
		files.push(parseFile(key, await readFile(join(opts.dir, key), 'utf8')));
	}

	const live = await loadLiveMap(g);

	for (const file of files) {
		const kind = resolveKind(file, opts.kindOf);
		if (!kind) {
			result.skipped.push({ key: file.key, reason: 'no kind' });
			continue;
		}
		const props = toProps(file.frontmatter);
		const prior = live.get(file.key);
		try {
			if (!prior) {
				await g.addNode({
					kind,
					body: file.body,
					uri: KEY_PREFIX + file.key,
					props,
					content_hash: file.hash,
					emb: await opts.embed(file.body),
				});
				result.added++;
			} else if (prior.hash !== file.hash) {
				await g.updateNode(prior.id, {
					kind,
					body: file.body,
					props,
					content_hash: file.hash,
					emb: await opts.embed(file.body),
				});
				result.updated++;
			} else {
				result.unchanged++;
			}
		} catch (err) {
			result.skipped.push({ key: file.key, reason: (err as Error).message });
		}
	}

	return result;
}
```

- [ ] **Step 4: Replace `packages/ingest/src/index.ts` with the real re-export**

```ts
export { ingestDir } from './ingest.ts';
export type { IngestOptions, IngestResult, ParsedFile } from './types.ts';
```

- [ ] **Step 5: Run the test on libSQL**

Run: `bun test packages/ingest/test/ingest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the test on Postgres**

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/ingest/test/ingest.test.ts`
Expected: PASS (4 tests). (Container `graphx-pgtest` must be up.)

- [ ] **Step 7: Type-check**

Run: `bun run type-check`
Expected: all packages exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/ingest/src/ingest.ts packages/ingest/src/index.ts packages/ingest/test/ingest.test.ts
git commit -m "feat(ingest): ingestDir node reconciliation (add/idempotent/update)"
```

---

### Task 7: `ingestDir` — edge reconciliation

**Files:**
- Modify: `packages/ingest/src/ingest.ts`
- Test: `packages/ingest/test/ingest.test.ts` (add cases)

**Interfaces:**
- Consumes: `extractLinks`/`Link` (Task 3), `buildPathIndex`/`resolveLink` (Task 4).
- Produces: edge counts in `IngestResult`; `links_to` edges between file nodes.

- [ ] **Step 1: Add failing tests to `packages/ingest/test/ingest.test.ts`**

```ts
test('ingestDir: links become edges; removing a link closes the edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\n---\nlinks to [[b]]',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	const r1 = await ingestDir({ dir, graph: g, embed });
	expect(r1.edgesAdded).toBe(1);
	const e1 = await client.execute('SELECT src, dst FROM edges');
	expect(e1.rows.length).toBe(1);

	await writeFile(join(dir, 'a.md'), '---\nkind: note\n---\nno more link');
	const r2 = await ingestDir({ dir, graph: g, embed });
	expect(r2.edgesClosed).toBe(1);
	const e2 = await client.execute('SELECT src, dst FROM edges');
	expect(e2.rows.length).toBe(0);

	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a link to a missing file is skipped, not fatal', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\nkind: note\n---\nbroken [[ghost]]' });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(1);
	expect(res.edgesAdded).toBe(0);
	expect(res.skipped).toContainEqual({ key: 'a.md', reason: 'unresolved link: ghost' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});
```

- [ ] **Step 2: Run to confirm the new cases fail**

Run: `bun test packages/ingest/test/ingest.test.ts`
Expected: FAIL — `edgesAdded` is 0 (no edge logic yet).

- [ ] **Step 3: Extend `packages/ingest/src/ingest.ts`**

Add imports at the top:

```ts
import { extractLinks } from './links.ts';
import { buildPathIndex, resolveLink } from './resolve.ts';
```

Add this helper near `loadLiveMap`:

```ts
/** Live out-edges of a node, via the `edges` view. */
async function liveOutEdges(
	g: LooseGraph,
	srcId: string,
): Promise<Array<{ id: string; rel: string; dst: string }>> {
	const r = await g.raw.execute({ sql: 'SELECT id, rel, dst FROM edges WHERE src = ?', args: [srcId] });
	return r.rows.map((row) => ({ id: String(row.id), rel: String(row.rel), dst: String(row.dst) }));
}

const REL = 'links_to';
```

In the node loop, record the id of every current file's node so links can resolve, and remember which files were touched. Change the three branches to capture ids and push touched files. Replace the node loop's body so it builds these two structures (declare them before the loop):

```ts
	const keyToId = new Map<string, string>();
	const touched: ParsedFile[] = [];
```

- new branch: after `await g.addNode(...)`, capture `const node = await g.addNode(...); keyToId.set(file.key, node.id); touched.push(file); result.added++;`
- changed branch: `keyToId.set(file.key, prior.id); touched.push(file); result.updated++;`
- unchanged branch: `keyToId.set(file.key, prior.id); result.unchanged++;`

Then after the node loop, add the edge-reconciliation pass:

```ts
	const index = buildPathIndex(files.map((f) => f.key));
	for (const file of touched) {
		const srcId = keyToId.get(file.key);
		if (!srcId) continue;
		const desired = new Set<string>();
		for (const link of extractLinks(file.body)) {
			const targetKey = resolveLink(link, file.key, index);
			if (!targetKey) {
				result.skipped.push({ key: file.key, reason: `unresolved link: ${link.target}` });
				continue;
			}
			const dst = keyToId.get(targetKey);
			if (dst && dst !== srcId) desired.add(dst);
		}
		const existing = await liveOutEdges(g, srcId);
		const have = new Set(existing.filter((e) => e.rel === REL).map((e) => e.dst));
		for (const dst of desired) {
			if (!have.has(dst)) {
				try {
					await g.addEdge({ rel: REL, src: srcId, dst });
					result.edgesAdded++;
				} catch (err) {
					result.skipped.push({ key: file.key, reason: (err as Error).message });
				}
			}
		}
		for (const e of existing) {
			if (e.rel === REL && !desired.has(e.dst)) {
				await g.deleteEdge(e.id);
				result.edgesClosed++;
			}
		}
	}

	return result;
```

(Remove the old `return result;` that followed the node loop — there must be exactly one, after the edge pass.)

> **Note on the harness:** the edit/close test calls `updateNode` and `deleteEdge`, which use interactive `transaction('write')`. On libSQL `:memory:` that is detached. If the test fails on libSQL with a transaction error, change the harness call in that test's `graph()` helper to `makeTestDb({ file: true }).client` and add `await teardown()` instead of `client.close()`. (Postgres is unaffected.)

- [ ] **Step 4: Run the full ingest test on libSQL**

Run: `bun test packages/ingest/test/ingest.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run on Postgres**

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/ingest/test/ingest.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/ingest/src/ingest.ts packages/ingest/test/ingest.test.ts
git commit -m "feat(ingest): edge reconciliation (links_to add/close)"
```

---

### Task 8: Package README + full verification

**Files:**
- Create: `packages/ingest/README.md`

**Interfaces:** none (docs + final gate).

- [ ] **Step 1: Create `packages/ingest/README.md`**

````markdown
# ingest

Ingest a local YAML/markdown vault into a [graphx](../core) graph: **1 file = 1 node**,
links become edges, re-runs reconcile incrementally using graphx's bitemporal model.

```ts
import { defineGraphSchema, Graph, getDb, init } from 'core';
import { ingestDir } from 'ingest';
import { z } from 'zod';

const schema = defineGraphSchema({
  nodes: { note: z.object({ title: z.string().optional() }).passthrough() },
  edges: { links_to: { from: 'note', to: 'note' } },
});

const db = getDb('my-vault');
await init(db, 768);
const graph = new Graph(db, schema);

const result = await ingestDir({
  dir: './vault',
  graph,
  embed: async (text) => myEmbedder(text), // (text: string) => Promise<number[]>
});
// { added, updated, unchanged, edgesAdded, edgesClosed, skipped }
```

## Conventions

- **Identity** = relative path, stored in the node `uri` column as `file:<path>`.
- **kind** = `frontmatter.kind`, else the top-level folder name (`kindOf` overrides).
- **props** = frontmatter minus `kind`, validated by the node kind's schema.
- **body** = markdown body (also the embed input).
- **edges** = `[[wikilink]]` (by basename) and `[text](./rel.md)` (by path) → `links_to`.
- **change detection** = sha256 of the file in `content_hash`; unchanged files are skipped (no re-embed).

## v1 limitations

- Deleted files leave stale live nodes (graphx has no public `deleteNode` yet).
- A rename creates a new node and orphans the old one.
- Local filesystem only (no S3 source yet).
- Links resolve only when the basename is unambiguous; otherwise the link is skipped.

See [`docs/superpowers/specs/2026-06-17-file-ingest-static-graph-design.md`](../../docs/superpowers/specs/2026-06-17-file-ingest-static-graph-design.md).
````

- [ ] **Step 2: Full matrix verification**

Run each and confirm:
- `bun run build` → emits `packages/ingest/dist/index.js` + `index.d.ts`
- `bun run type-check` → all packages exit 0
- `bun run lint` → exit 0
- `bun test` → libSQL suite green, including all `packages/ingest/test/*` (parse 3, links 3, resolve 3, discover 1, ingest 6)
- `GRAPHX_TEST_DRIVER=postgres bun test` → PG suite green (ingest tests included)

- [ ] **Step 3: Commit**

```bash
git add packages/ingest/README.md
git commit -m "docs(ingest): package README"
```

---

## Self-Review

**Spec coverage:**
- Convention 1 file = 1 node → Tasks 2, 6 (`resolveKind`, props/body/uri mapping). ✓
- Identity in `uri`/`content_hash` columns → Task 6 (`loadLiveMap`, `addNode` uri). ✓
- Incremental temporal upsert (add/update/skip by hash) → Task 6. ✓
- Embeddings on add/change → Task 6 (`embed` on add + update branches). ✓
- Links → `links_to` edges, add + close → Task 7. ✓
- Query-the-graph diff state (no sidecar) → Task 6 (`loadLiveMap` via `graph.raw`). ✓
- New `packages/ingest`, `core` peer, type-only at runtime → Task 1. ✓
- Unknown kind / unresolved link skipped, not fatal → Tasks 6, 7. ✓
- Dual-backend tests → Tasks 6, 7, 8. ✓
- v1 limits documented → Task 8 README. ✓
- **Deviation from spec:** `include` is an **extension allowlist**, not globs (zero-dep, fully typed). Noted here and in the README; faithful simplification of the spec's `include?: string[]`.

**Placeholder scan:** none — every code step has complete code; every command has expected output.

**Type consistency:** `ParsedFile.key`/`hash`/`frontmatter`/`body` used consistently across Tasks 2/4/6/7; `Link {kind,target}` from Task 3 used in Tasks 4/7; `LooseGraph` method shapes match `core`'s real `addNode`/`updateNode`/`addEdge`/`deleteEdge`/`raw.execute` signatures; `IngestResult` fields identical across Tasks 1/6/7. Relation literal `links_to` matches the test schema's edge name.
