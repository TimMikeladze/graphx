# DuckDB Object-Storage Backend — Stages 1–4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third graphx backend — an embedded DuckDB whose durable state is immutable Parquet in an object-storage bucket — reaching the point where the existing core test suite runs green under `GRAPHX_TEST_DRIVER=duckdb` against a real bucket.

**Architecture:** `DuckClient` implements the existing `DbClient` interface with `dialect: 'duckdb'`, so every call site is unchanged. Its durable state is a chain of immutable snapshots in a bucket: each commit writes content-addressed Parquet and claims the next snapshot number with a create-if-absent PUT, which makes the object store itself the writer lock. Live rows are stored in a separate physical table from history, which turns every partial index in the schema into a plain index.

**Tech Stack:** TypeScript, Bun (test runner + package manager), `@duckdb/node-api` 1.5.5-r.2 (optional peer), `@aws-sdk/client-s3` (optional peer, already present), Parquet via DuckDB's own `COPY`/`read_parquet`.

**Spec:** `docs/superpowers/specs/2026-07-28-duckdb-object-storage-design.md`. Read §6–§9 before starting.

## Global Constraints

- **Backend selection is config-only.** Every public type, method signature, route shape, and JSON wire contract stays byte-stable. Same constraint Postgres shipped under (`docs/POSTGRES_SUPPORT.md` §0).
- **`@duckdb/node-api` is an OPTIONAL peer dependency.** It must only load when a consumer imports the `@graphx/core/duck` subpath. Never from `src/index.ts`.
- **Pinned versions:** `@duckdb/node-api@1.5.5-r.2` (wraps DuckDB v1.5.5). Do not use the `lts-v1.4` tag — `USING KEY` recursive-CTE syntax differs incompatibly between the 1.4 and 1.5 lines.
- **FOREVER sentinel is `8640000000000000`.** DuckDB `INTEGER` is 32-bit and overflows it; every temporal column and cast is `BIGINT`.
- **Never call `listValue()` or `arrayValue()` without an explicit type.** They infer element type from the first element alone and silently truncate floats. Embeddings bind as `JSON.stringify(vec)` with a `::FLOAT[dim]` cast.
- **A transaction owns a dedicated connection for its whole lifetime.** One connection is serialized but shared; two async tasks interleaving on it silently merge their transactions.
- **`COMMIT` on an aborted DuckDB transaction resolves successfully and discards the writes.** Never treat a resolved `commit()` as proof of durability.
- **Content-addressed objects are immutable.** Never overwrite a `data/<sha256>.parquet` key. Never delete one that a reachable manifest references.
- **Test command:** `bun test --timeout 30000` from the repo root. Lint: `bun run lint`. Types: `bun run type-check`.
- **Commit style:** conventional commits, matching existing history (`feat(core):`, `fix(core):`, `test(core):`, `refactor(core):`).

---

## File Structure

**Stage 1 — seam hardening (no new files):**
- Modify `packages/core/src/dialect.ts` — add `'duckdb'` to `Dialect`, add `assertNever`.
- Modify `packages/core/src/dialect-sql.ts` — convert every fragment from a two-way ternary to an exhaustive `switch`.
- Modify the 12 inline dialect branches: `schema.ts`, `db.ts`, `constraints.ts`, `temporal.ts`, `algorithms.ts`, `bulk.ts`, `journey.ts`, `pattern.ts`.
- Modify `packages/core/test/harness.ts` — invert the skip gate to an allowlist.

**Stage 2 — storage layer (new, standalone, no DuckDB):**
- Create `packages/core/src/objstore/store.ts` — the `ObjectStore` interface and its errors. One responsibility: the provider-neutral contract.
- Create `packages/core/src/objstore/memory.ts` — in-memory `ObjectStore` for unit tests.
- Create `packages/core/src/objstore/file.ts` — filesystem `ObjectStore`, the default test store.
- Create `packages/core/src/objstore/s3.ts` — S3/R2/GCS/MinIO `ObjectStore` plus the startup CAS probe.
- Create `packages/core/src/objstore/manifest.ts` — manifest types, parse, serialize, hash.
- Create `packages/core/src/objstore/snapshot.ts` — `SnapshotStore`: resolve head, read, commit with CAS retry.
- Create `packages/core/src/objstore/cache.ts` — content-addressed local file cache.
- Create `packages/core/test/objstore/*.test.ts` — one test file per module above.

**Stage 3 — DuckDB adapter (new):**
- Create `packages/core/src/duck.ts` — `DuckClient`, `createDuckClient`, `registerDuckDriver` call. Mirrors `pg.ts` exactly in shape and role.
- Create `packages/core/src/duck-pool.ts` — `DuckDBInstance` lifecycle, connection checkout, FATAL detection and rebuild.
- Create `packages/core/src/duck-value.ts` — JS↔DuckDB value marshalling (bigint normalization, embedding binding).
- Modify `packages/core/src/dialect-sql.ts` — fill in the `duckdb` arms.
- Modify `packages/core/src/schema.ts` — `duckdbSchema(dim)`, plus `init`/`readEmbDim`/`ensureColumn` arms.
- Modify `packages/core/package.json`, `bunup.config.ts` — `./duck` subpath and build entry.

**Stage 4 — snapshots (new):**
- Create `packages/core/src/duck-materialize.ts` — snapshot → local DuckDB tables/views.
- Create `packages/core/src/duck-commit.ts` — local tables → Parquet → manifest commit.
- Modify `packages/core/src/duck.ts` — wire materialize/commit into the client lifecycle.
- Modify `packages/core/src/graph.ts` — the `write(fn)` session, and the DuckDB entries in `isRetryableContention`.
- Modify `packages/core/src/serve.ts` — map "too much contention" to 409.

---

## Task 1: Make the dialect seam exhaustive

Today `Dialect` is a two-member union and every branch is `dialect === 'postgres' ? A : B`. Adding a third member without this task means a `duckdb` client silently takes the libSQL arm everywhere and dies at `init()` with an unrelated error. Converting to exhaustive switches turns each of those into a compile error instead.

**Files:**
- Modify: `packages/core/src/dialect.ts:16` (the `Dialect` union) and append `assertNever`
- Modify: `packages/core/src/dialect-sql.ts` (all 22 exported fragments)
- Test: `packages/core/test/dialect-sql.test.ts` (create)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `type Dialect = 'libsql' | 'postgres' | 'duckdb'`; `function assertNever(x: never, ctx: string): never`. Every fragment in `dialect-sql.ts` keeps its existing exported name and signature, and throws `dialect-sql: <name>(duckdb) not implemented yet` when called with `'duckdb'`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/dialect-sql.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { Dialect } from '../src/dialect.ts';
import { assertNever } from '../src/dialect.ts';
import { epochIntType, jsonField, scalarMax } from '../src/dialect-sql.ts';

describe('dialect seam exhaustiveness', () => {
	test('duckdb is a member of the Dialect union', () => {
		const d: Dialect = 'duckdb';
		expect(d).toBe('duckdb');
	});

	test('libsql and postgres fragments are byte-stable', () => {
		expect(scalarMax('libsql', 'a', 'b')).toBe('MAX(a, b)');
		expect(scalarMax('postgres', 'a', 'b')).toBe('GREATEST(a, b)');
		expect(jsonField('libsql', 'data', 'k')).toBe("data ->> 'k'");
		expect(jsonField('postgres', 'data', 'k')).toBe("(data)::jsonb ->> 'k'");
		expect(epochIntType('libsql')).toBe('INTEGER');
		expect(epochIntType('postgres')).toBe('BIGINT');
	});

	test('an unimplemented duckdb fragment throws a named error', () => {
		expect(() => jsonField('duckdb', 'data', 'k')).toThrow(/jsonField\(duckdb\)/);
	});

	test('assertNever reports the offending value', () => {
		expect(() => assertNever('nope' as never, 'testCtx')).toThrow(/testCtx.*nope/);
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/dialect-sql.test.ts`
Expected: FAIL — `assertNever` is not exported from `dialect.ts`, and `'duckdb'` is not assignable to `Dialect`.

- [ ] **Step 3: Widen the union and add `assertNever`**

In `packages/core/src/dialect.ts`, replace line 16 and append the helper:

```ts
/** Which SQL backend a client speaks. Absent ⇒ libSQL (the original / default). */
export type Dialect = 'libsql' | 'postgres' | 'duckdb';
```

```ts
/**
 * Exhaustiveness guard for dialect switches. Every `switch (dialect)` in the codebase
 * ends in `default: return assertNever(dialect, '<fragmentName>')`, so adding a fourth
 * backend surfaces as a compile error at every branch that has not been taught about it
 * — rather than as a silent fall-through to the libSQL arm, which is what the two-way
 * ternaries this replaced would have done.
 */
export function assertNever(x: never, ctx: string): never {
	throw new Error(`${ctx}: unhandled dialect ${JSON.stringify(x)}`);
}
```

- [ ] **Step 4: Convert every fragment to an exhaustive switch**

In `packages/core/src/dialect-sql.ts`, replace the `notYet` helper so it names the dialect, and convert each fragment. Replace lines 200-204:

```ts
function notYet(fragment: string, dialect: Dialect): never {
	throw new Error(`dialect-sql: ${fragment}(${dialect}) not implemented yet`);
}
```

Then convert each of the 22 fragments. The mechanical pattern, shown for the three simplest — apply the identical shape to every other fragment, preserving its current libSQL and Postgres strings **byte-for-byte**:

```ts
export function scalarMax(dialect: Dialect, a: string, b: string): string {
	switch (dialect) {
		case 'libsql':
			return `MAX(${a}, ${b})`;
		case 'postgres':
			return `GREATEST(${a}, ${b})`;
		case 'duckdb':
			return notYet('scalarMax', dialect);
		default:
			return assertNever(dialect, 'scalarMax');
	}
}

export function jsonField(dialect: Dialect, col: string, key: string): string {
	switch (dialect) {
		case 'libsql':
			return `${col} ->> '${key}'`;
		case 'postgres':
			return `(${col})::jsonb ->> '${key}'`;
		case 'duckdb':
			return notYet('jsonField', dialect);
		default:
			return assertNever(dialect, 'jsonField');
	}
}

export function epochIntType(dialect: Dialect): string {
	switch (dialect) {
		case 'libsql':
			return 'INTEGER';
		case 'postgres':
			return 'BIGINT';
		case 'duckdb':
			return notYet('epochIntType', dialect);
		default:
			return assertNever(dialect, 'epochIntType');
	}
}
```

The full list to convert, in file order: `scalarMax`, `jsonField`, `epochIntType`, `jsonEqExpr`, `jsonEqArg`, `distinctSelect`, `embColumnType`, `embFreshExpr`, `ftsWhere`, `annSeedsLive`, `annSeedsAsOf`, `vecSeedLive`, `ftsSeedLive`, `ftsSeedAsOf`, `insertOrIgnore`, `jsonArrayRows`, `embExtract`, `embRebindExpr`, `vectorIndexDDL`, `ftsTableDDL`, `ftsTriggerDDL`. `postgresSchema` takes no dialect parameter and is left alone.

Note two that already differ from the plain ternary shape: `jsonEqArg` returns a value not a string (its `libsql` arm is `return value`, its `postgres` arm the `String()` coercion, its `duckdb` arm `notYet`), and `distinctSelect` returns an object.

Import `assertNever` at the top of `dialect-sql.ts`:

```ts
import { assertNever, type Dialect } from './dialect.ts';
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/core/test/dialect-sql.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify nothing regressed**

Run: `bun test --timeout 30000`
Expected: PASS. The libSQL suite must be exactly as green as before this task — every fragment's libSQL output is byte-identical, so any failure here means a transcription error in step 4.

Run: `bun run type-check && bun run lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/dialect.ts packages/core/src/dialect-sql.ts packages/core/test/dialect-sql.test.ts
git commit -m "refactor(core): make the dialect seam exhaustive

Widens Dialect to include duckdb and converts every fragment in
dialect-sql.ts from a two-way ternary to a switch with an assertNever
default. A dialect no branch has been taught about is now a compile
error instead of a silent fall-through to the libSQL arm."
```

---

## Task 2: Give the 12 inline dialect branches a duckdb arm, and fix the harness skip gate

Twelve call sites branch on the dialect outside `dialect-sql.ts`. Each is a bare `=== 'postgres'` test with no default, so a `duckdb` client takes the libSQL path — issuing PRAGMAs and querying `sqlite_master`. Separately, the test harness's skip gate is `TEST_DRIVER === 'postgres' ? test.skip : test`, which means 18 libSQL-internals probes would *run* under any third driver.

**Files:**
- Modify: `packages/core/src/db.ts:14-18` (`applyConnPragmas`)
- Modify: `packages/core/src/schema.ts:166-186` (`readEmbDim`), `:188-218` (`init`), `:227-237` (`ensureColumn`)
- Modify: `packages/core/src/constraints.ts:62`, `packages/core/src/temporal.ts:294,320`, `packages/core/src/algorithms.ts:341`, `packages/core/src/bulk.ts:200,238,246`, `packages/core/src/journey.ts:104-106`, `packages/core/src/pattern.ts:206-215`
- Modify: `packages/core/test/harness.ts:40-43`
- Test: `packages/core/test/duck-guards.test.ts` (create)

**Interfaces:**
- Consumes: `Dialect` and `assertNever` from Task 1.
- Produces: `TEST_DRIVER: Dialect` (was `string`) and `libsqlOnly` exported from `packages/core/test/harness.ts`. Every inline branch throws `<module>: duckdb not implemented yet` when reached with a duckdb client, so Stage 3 can find them by running the suite.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/duck-guards.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { applyConnPragmas } from '../src/db.ts';
import type { DbClient } from '../src/dialect.ts';

/** A DbClient that records statements and never touches a real database. */
function fakeClient(dialect: 'libsql' | 'postgres' | 'duckdb'): DbClient & { seen: string[] } {
	const seen: string[] = [];
	return {
		dialect,
		seen,
		execute: async (stmt) => {
			seen.push(typeof stmt === 'string' ? stmt : stmt.sql);
			return { rows: [], rowsAffected: 0 };
		},
		batch: async () => [],
		transaction: async () => {
			throw new Error('unused');
		},
		executeMultiple: async () => {},
		close: () => {},
	};
}

describe('inline dialect guards', () => {
	test('applyConnPragmas issues PRAGMAs on libsql', async () => {
		const c = fakeClient('libsql');
		await applyConnPragmas(c);
		expect(c.seen).toEqual(['PRAGMA foreign_keys = ON', 'PRAGMA busy_timeout = 5000']);
	});

	test('applyConnPragmas is a no-op on postgres', async () => {
		const c = fakeClient('postgres');
		await applyConnPragmas(c);
		expect(c.seen).toEqual([]);
	});

	test('applyConnPragmas is a no-op on duckdb — it must not issue PRAGMAs', async () => {
		const c = fakeClient('duckdb');
		await applyConnPragmas(c);
		expect(c.seen).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-guards.test.ts`
Expected: FAIL on the third test — a duckdb client currently falls through to the libSQL arm and records two PRAGMAs.

- [ ] **Step 3: Convert `applyConnPragmas`**

In `packages/core/src/db.ts`, replace the body of `applyConnPragmas` (lines 14-18):

```ts
export async function applyConnPragmas(client: DbClient): Promise<void> {
	// libSQL only. Postgres has these inherently (FKs always enforced, MVCC,
	// lock_timeout). DuckDB has no equivalent knobs and no lock-based contention —
	// its writer is serialized in-process by the adapter's mutex instead.
	if (dialectOf(client) !== 'libsql') return;
	await client.execute('PRAGMA foreign_keys = ON');
	await client.execute('PRAGMA busy_timeout = 5000');
}
```

- [ ] **Step 4: Convert the remaining eleven branches**

Each currently reads `dialectOf(client) === 'postgres'` (or a local `isPg`). Rewrite each as a `switch` with an explicit `duckdb` arm. Where Stage 3 will supply real behavior, the arm throws so the suite locates it; where the correct duckdb behavior is already known from the spec, implement it now.

Known-now arms (implement):

```ts
// schema.ts — ensureColumn. DuckDB has ADD COLUMN IF NOT EXISTS, so the probe is
// unnecessary; PRAGMA table_xinfo does not exist there at all.
export async function ensureColumn(
	client: DbClient,
	table: string,
	col: string,
	ddl: string,
): Promise<void> {
	if (dialectOf(client) === 'duckdb') {
		await client.execute(ddl.replace(/ADD COLUMN /i, 'ADD COLUMN IF NOT EXISTS '));
		return;
	}
	const info = await client.execute(`PRAGMA table_xinfo(${table})`);
	if (!info.rows.some((r) => String(r.name) === col)) {
		await client.execute(ddl);
	}
}
```

```ts
// algorithms.ts:341 — ORDER BY inside a recursive term is a SQLite-only extension.
// DuckDB rejects it exactly as Postgres does ("ORDER BY in a recursive query is not
// allowed"), so it takes the same branch: no in-recursion pruning, outer ORDER BY.
const orderClause = dialectOf(this.raw) === 'libsql' ? 'ORDER BY cost' : '';
```

```ts
// temporal.ts:294,320 — the outbox visibility gate exists to hide rows from in-flight
// transactions using the Postgres snapshot xmin horizon. libSQL needs none (single
// writer); DuckDB needs none for the same reason (the adapter serializes writers), and
// exposes no transaction horizon to build one from.
const visible = dialectOf(client) === 'postgres' ? PG_OUTBOX_VISIBLE : '';
```

Throw-for-now arms (Stage 3 fills them): `schema.ts` `readEmbDim` and `init`, `constraints.ts:62`, `bulk.ts:200,238,246`, `journey.ts:104-106`, `pattern.ts:206-215`. Pattern for each:

```ts
switch (dialectOf(client)) {
	case 'postgres':
		/* existing postgres body, unchanged */
		break;
	case 'duckdb':
		throw new Error('schema.init: duckdb not implemented yet');
	default:
		/* existing libsql body, unchanged */
		break;
}
```

- [ ] **Step 5: Fix the harness skip gate**

In `packages/core/test/harness.ts`, replace lines 40-43:

```ts
/** Selected backend. `libsql` (default) preserves current behavior; others opt in via env. */
const DRIVER = (process.env.GRAPHX_TEST_DRIVER ?? 'libsql') as Dialect;

/** The active test backend. */
export const TEST_DRIVER: Dialect = DRIVER;

/**
 * Gate for probes that assert libSQL INTERNALS — PRAGMA output, `sqlite_master` rows,
 * `EXPLAIN QUERY PLAN` index selection, `vector_top_k`, FTS5 virtual-table mechanics.
 * An ALLOWLIST, not a postgres denylist: the old `TEST_DRIVER === 'postgres' ? skip : test`
 * form ran all 18 of these under any third driver, where they cannot pass. The
 * user-facing contracts they cover are exercised by cross-backend tests.
 */
export const libsqlOnly = DRIVER === 'libsql' ? test : test.skip;
```

Add the imports `import { test } from 'bun:test';` and `import type { Dialect } from '../src/dialect.ts';` at the top of the harness.

Then update every current use. Find them with:

```bash
grep -rn "TEST_DRIVER === 'postgres'" packages/core/test packages/auth/test
```

Replace each `const libsqlOnly = TEST_DRIVER === 'postgres' ? test.skip : test;` (or its inline equivalent) with `import { libsqlOnly } from './harness.ts';` and delete the local definition.

- [ ] **Step 6: Run the tests**

Run: `bun test packages/core/test/duck-guards.test.ts`
Expected: PASS, 3 tests.

Run: `bun test --timeout 30000`
Expected: PASS, unchanged from Task 1. The allowlist change is a no-op under the default `libsql` driver.

Run: `GRAPHX_TEST_DRIVER=postgres bun test --timeout 30000` if a Postgres container is available (`docker run -d -p 5455:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16`, then `CREATE DATABASE graphx_test` and `CREATE EXTENSION vector`).
Expected: unchanged from before this task.

Run: `bun run type-check && bun run lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/core/test packages/auth
git commit -m "refactor(core): give every inline dialect branch a duckdb arm

Converts the twelve bare '=== postgres' tests outside dialect-sql.ts into
explicit switches. Arms whose duckdb behavior the design already settles
are implemented; the rest throw by name so stage 3 can locate them by
running the suite.

Also inverts the harness skip gate to an allowlist. It read
TEST_DRIVER === 'postgres' ? test.skip : test, which ran all eighteen
libSQL-internals probes under any driver that was not literally postgres."
```

---

## Task 3: The `ObjectStore` contract, with memory and filesystem implementations

The whole commit protocol rests on one primitive: create a key, fail if it already exists. This task defines that contract and the two implementations tests use. No DuckDB, no S3 — this task is verifiable entirely offline.

**Files:**
- Create: `packages/core/src/objstore/store.ts`
- Create: `packages/core/src/objstore/memory.ts`
- Create: `packages/core/src/objstore/file.ts`
- Test: `packages/core/test/objstore/store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface ObjectStore { get(key): Promise<Uint8Array | null>; getIfChanged(key, etag?): Promise<{ body: Uint8Array; etag: string } | 'unchanged' | null>; put(key, body): Promise<void>; putIfAbsent(key, body): Promise<void>; list(prefix): Promise<string[]>; delete(key): Promise<void>; }`
  - `class ObjectExistsError extends Error` — thrown by `putIfAbsent` when the key is taken. Carries `readonly key: string`.
  - `class MemoryObjectStore implements ObjectStore`, `class FileObjectStore implements ObjectStore` with constructor `(rootDir: string)`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/objstore/store.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { FileObjectStore } from '../../src/objstore/file.ts';
import { MemoryObjectStore } from '../../src/objstore/memory.ts';
import { ObjectExistsError, type ObjectStore } from '../../src/objstore/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'graphx-objstore-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const stores: Array<[string, () => ObjectStore]> = [
	['memory', () => new MemoryObjectStore()],
	['file', () => new FileObjectStore(mkdtempSync(join(dir, 'fs-')))],
];

for (const [name, make] of stores) {
	describe(`ObjectStore: ${name}`, () => {
		test('get returns null for a missing key', async () => {
			expect(await make().get('nope')).toBeNull();
		});

		test('put then get round-trips bytes', async () => {
			const s = make();
			await s.put('a/b.txt', enc('hello'));
			expect(dec((await s.get('a/b.txt')) as Uint8Array)).toBe('hello');
		});

		test('putIfAbsent succeeds on a new key', async () => {
			const s = make();
			await s.putIfAbsent('k', enc('one'));
			expect(dec((await s.get('k')) as Uint8Array)).toBe('one');
		});

		test('putIfAbsent on a taken key throws ObjectExistsError and does not overwrite', async () => {
			const s = make();
			await s.putIfAbsent('k', enc('one'));
			await expect(s.putIfAbsent('k', enc('two'))).rejects.toBeInstanceOf(ObjectExistsError);
			expect(dec((await s.get('k')) as Uint8Array)).toBe('one');
		});

		test('exactly one of N concurrent putIfAbsent calls wins', async () => {
			const s = make();
			const results = await Promise.allSettled(
				Array.from({ length: 12 }, (_, i) => s.putIfAbsent('race', enc(String(i)))),
			);
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			for (const r of results.filter((r) => r.status === 'rejected')) {
				expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ObjectExistsError);
			}
		});

		test('list returns keys under a prefix, sorted', async () => {
			const s = make();
			await s.put('snapshots/2', enc('b'));
			await s.put('snapshots/1', enc('a'));
			await s.put('data/x', enc('c'));
			expect(await s.list('snapshots/')).toEqual(['snapshots/1', 'snapshots/2']);
		});

		test('getIfChanged returns "unchanged" for a matching etag', async () => {
			const s = make();
			await s.put('m', enc('v1'));
			const first = await s.getIfChanged('m');
			if (first === null || first === 'unchanged') throw new Error('expected a body');
			expect(await s.getIfChanged('m', first.etag)).toBe('unchanged');
			await s.put('m', enc('v2'));
			const second = await s.getIfChanged('m', first.etag);
			if (second === null || second === 'unchanged') throw new Error('expected a new body');
			expect(dec(second.body)).toBe('v2');
		});

		test('delete removes a key', async () => {
			const s = make();
			await s.put('gone', enc('x'));
			await s.delete('gone');
			expect(await s.get('gone')).toBeNull();
		});
	});
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/objstore/store.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write `store.ts`**

```ts
/**
 * Provider-neutral object-storage contract. The commit protocol needs exactly one
 * non-trivial primitive — {@link ObjectStore.putIfAbsent}, "create this key, fail if it
 * already exists" — because that is what serializes writers without a lock service or a
 * catalog database. Everything else here is ordinary get/put/list/delete.
 *
 * Deliberately NOT an If-Match conditional overwrite: create-if-absent is the most widely
 * supported primitive across providers, and the protocol never needs to overwrite a key
 * whose contents matter (see `_head`, which is a hint).
 */
export interface ObjectStore {
	/** Object bytes, or null when the key does not exist. */
	get(key: string): Promise<Uint8Array | null>;
	/**
	 * Conditional read. Returns `'unchanged'` when `etag` still matches (an HTTP 304 or its
	 * local equivalent), a `{ body, etag }` pair when it does not, or null when absent.
	 * This is what keeps the per-query manifest resolve cheap.
	 */
	getIfChanged(
		key: string,
		etag?: string,
	): Promise<{ body: Uint8Array; etag: string } | 'unchanged' | null>;
	/** Unconditional write. */
	put(key: string, body: Uint8Array): Promise<void>;
	/** Create-only write. Throws {@link ObjectExistsError} if the key is taken. */
	putIfAbsent(key: string, body: Uint8Array): Promise<void>;
	/** Keys under `prefix`, sorted ascending. */
	list(prefix: string): Promise<string[]>;
	delete(key: string): Promise<void>;
}

/** `putIfAbsent` lost the race — another writer already created this key. */
export class ObjectExistsError extends Error {
	constructor(readonly key: string) {
		super(`object already exists: ${key}`);
		this.name = 'ObjectExistsError';
	}
}
```

- [ ] **Step 4: Write `memory.ts`**

```ts
import { ObjectExistsError, type ObjectStore } from './store.ts';

/**
 * In-memory {@link ObjectStore} for unit tests. `putIfAbsent` is atomic because JS is
 * single-threaded and the check-and-set below contains no `await` — the concurrency test
 * in store.test.ts asserts exactly that.
 */
export class MemoryObjectStore implements ObjectStore {
	private readonly objects = new Map<string, { body: Uint8Array; etag: string }>();
	private counter = 0;

	async get(key: string): Promise<Uint8Array | null> {
		return this.objects.get(key)?.body ?? null;
	}

	async getIfChanged(key: string, etag?: string) {
		const o = this.objects.get(key);
		if (!o) return null;
		if (etag !== undefined && etag === o.etag) return 'unchanged' as const;
		return { body: o.body, etag: o.etag };
	}

	async put(key: string, body: Uint8Array): Promise<void> {
		this.objects.set(key, { body, etag: `e${++this.counter}` });
	}

	async putIfAbsent(key: string, body: Uint8Array): Promise<void> {
		// No await between the check and the set — this is the atomic section.
		if (this.objects.has(key)) throw new ObjectExistsError(key);
		this.objects.set(key, { body, etag: `e${++this.counter}` });
	}

	async list(prefix: string): Promise<string[]> {
		return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}
}
```

- [ ] **Step 5: Write `file.ts`**

```ts
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { ObjectExistsError, type ObjectStore } from './store.ts';

/**
 * Filesystem {@link ObjectStore} — the default test store, and a legitimate single-host
 * deployment target. `putIfAbsent` uses `O_CREAT | O_EXCL`, which is the POSIX
 * create-if-absent primitive and is atomic on every mainstream filesystem, so it models
 * S3's `If-None-Match: *` faithfully rather than approximating it with a stat-then-write.
 */
export class FileObjectStore implements ObjectStore {
	constructor(private readonly rootDir: string) {}

	private path(key: string): string {
		return join(this.rootDir, ...key.split('/'));
	}

	/**
	 * Absence is load-bearing in this protocol — `resolveHead` probes forward until a
	 * snapshot is missing — so only a genuine "not there" may return null. A catch-all
	 * would make a permission error or a path collision indistinguishable from absence,
	 * and silently resolve an older snapshot as head.
	 */
	async get(key: string): Promise<Uint8Array | null> {
		try {
			return new Uint8Array(await readFile(this.path(key)));
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') return null;
			throw e;
		}
	}

	async getIfChanged(key: string, etag?: string) {
		const body = await this.get(key);
		if (body === null) return null;
		const current = createHash('sha256').update(body).digest('hex').slice(0, 32);
		if (etag !== undefined && etag === current) return 'unchanged' as const;
		return { body, etag: current };
	}

	async put(key: string, body: Uint8Array): Promise<void> {
		const p = this.path(key);
		await mkdir(dirname(p), { recursive: true });
		await this.writeThenMove(p, body, rename);
	}

	/**
	 * Create-only, and atomic in BOTH senses that matter: only one caller wins, and the
	 * key never exists in a half-written state.
	 *
	 * `O_CREAT | O_EXCL` alone gives only the first: it makes the file exist at zero bytes
	 * and the body lands in a second step, so a reader racing that window gets a truncated
	 * object instead of `null` — and in this protocol that reader is `resolveHead` parsing
	 * a manifest. Writing to a temp file first and `link()`ing it into place gives both:
	 * `link` fails `EEXIST` atomically, and the name it publishes is already complete.
	 */
	async putIfAbsent(key: string, body: Uint8Array): Promise<void> {
		const p = this.path(key);
		await mkdir(dirname(p), { recursive: true });
		await this.writeThenMove(p, body, link, key);
	}

	/** Write to a sibling temp file, then publish it under `target` in one step. */
	private async writeThenMove(
		target: string,
		body: Uint8Array,
		publish: (from: string, to: string) => Promise<void>,
		exclusiveKey?: string,
	): Promise<void> {
		const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmp, body);
		try {
			await publish(tmp, target);
		} catch (e) {
			if (exclusiveKey !== undefined && (e as NodeJS.ErrnoException).code === 'EEXIST') {
				throw new ObjectExistsError(exclusiveKey);
			}
			throw e;
		} finally {
			await rm(tmp, { force: true });
		}
	}

	async list(prefix: string): Promise<string[]> {
		const out: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			let entries: Awaited<ReturnType<typeof readdir>>;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const full = join(dir, e.name);
				if (e.isDirectory()) await walk(full);
				else out.push(relative(this.rootDir, full).split(sep).join('/'));
			}
		};
		await walk(this.rootDir);
		return out.filter((k) => k.startsWith(prefix)).sort();
	}

	async delete(key: string): Promise<void> {
		await rm(this.path(key), { force: true });
	}
}
```

Two assertions the eight shared tests do not cover, because they all await the writer before reading. Add them to `store.test.ts` for the file store specifically:

```ts
test('a key is never observable half-written', async () => {
	const s = new FileObjectStore(mkdtempSync(join(dir, 'fs-')));
	const big = new Uint8Array(4 * 1024 * 1024).fill(7);
	const writing = s.putIfAbsent('big', big);
	// Race the write: every read must see either nothing or the whole object.
	for (let i = 0; i < 50; i++) {
		const seen = await s.get('big');
		if (seen !== null) expect(seen.length).toBe(big.length);
	}
	await writing;
	expect((await s.get('big'))?.length).toBe(big.length);
});

test('get surfaces a real I/O error instead of reporting absence', async () => {
	const root = mkdtempSync(join(dir, 'fs-'));
	const s = new FileObjectStore(root);
	// A directory where an object should be: EISDIR, which is not "absent".
	mkdirSync(join(root, 'collide'), { recursive: true });
	await expect(s.get('collide')).rejects.toThrow();
});
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/core/test/objstore/store.test.ts`
Expected: PASS, 16 tests (8 per store).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/objstore packages/core/test/objstore
git commit -m "feat(core): add the ObjectStore contract with memory and file backends

putIfAbsent is the one primitive the snapshot commit protocol needs: it is
what serializes writers without a lock service or a catalog database. The
filesystem implementation uses O_CREAT|O_EXCL so it models S3's
If-None-Match semantics rather than approximating them."
```

---

## Task 4: The S3 `ObjectStore` and the startup CAS probe

`If-None-Match: *` is supported by S3, R2, MinIO, and Tigris. GCS's S3-compatible endpoint needs `x-goog-if-generation-match: 0` instead, and whether it *rejects or silently ignores* the S3 spelling is unknown — silent-ignore would degrade create-only into unconditional overwrite. Backblaze B2 has no conditional write in either API. The probe turns all of that into a fact at connect time.

**Files:**
- Create: `packages/core/src/objstore/s3.ts`
- Test: `packages/core/test/objstore/s3.test.ts`

**Interfaces:**
- Consumes: `ObjectStore`, `ObjectExistsError` from Task 3.
- Produces:
  - `interface S3ObjectStoreOptions { bucket: string; prefix?: string; region?: string; endpoint?: string; forcePathStyle?: boolean; credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }; conditionalWrite?: 'if-none-match' | 'gcs-generation'; }`
  - `class S3ObjectStore implements ObjectStore` with constructor `(opts: S3ObjectStoreOptions)`
  - `async function probeConditionalWrite(store: ObjectStore): Promise<void>` — throws `ConditionalWriteUnsupportedError` when a second `putIfAbsent` on the same key succeeds.
  - `class ConditionalWriteUnsupportedError extends Error`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/objstore/s3.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryObjectStore } from '../../src/objstore/memory.ts';
import {
	ConditionalWriteUnsupportedError,
	probeConditionalWrite,
} from '../../src/objstore/s3.ts';
import type { ObjectStore } from '../../src/objstore/store.ts';

/** A store whose putIfAbsent silently overwrites — the GCS-silent-ignore failure mode. */
class LyingStore extends MemoryObjectStore {
	override async putIfAbsent(key: string, body: Uint8Array): Promise<void> {
		await this.put(key, body);
	}
}

describe('conditional-write probe', () => {
	test('passes against a store that enforces create-only', async () => {
		await probeConditionalWrite(new MemoryObjectStore());
	});

	test('fails loudly against a store that silently overwrites', async () => {
		await expect(probeConditionalWrite(new LyingStore())).rejects.toBeInstanceOf(
			ConditionalWriteUnsupportedError,
		);
	});

	test('leaves no probe object behind', async () => {
		const s: ObjectStore = new MemoryObjectStore();
		await probeConditionalWrite(s);
		expect(await s.list('')).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/objstore/s3.test.ts`
Expected: FAIL — `s3.ts` does not exist.

- [ ] **Step 3: Write `s3.ts`**

```ts
import { createHash } from 'node:crypto';
import {
	DeleteObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { ObjectExistsError, type ObjectStore } from './store.ts';

/**
 * S3-compatible {@link ObjectStore}. Verified against AWS S3 and MinIO; R2 and Tigris
 * document the same `If-None-Match: *` behavior.
 *
 * `conditionalWrite` selects the create-only mechanism. `'if-none-match'` (the default)
 * sends `If-None-Match: *` and treats 412/409 as "lost the race". `'gcs-generation'`
 * sends `x-goog-if-generation-match: 0` instead, which is what Google's XML API actually
 * honors on PUT — its header reference documents `If-None-Match` for GET and HEAD only.
 * Backblaze B2 supports neither and is unsupported.
 */
export interface S3ObjectStoreOptions {
	bucket: string;
	prefix?: string;
	region?: string;
	endpoint?: string;
	forcePathStyle?: boolean;
	credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
	conditionalWrite?: 'if-none-match' | 'gcs-generation';
}

/** The store accepted a create-only write over an existing key — it does not enforce CAS. */
export class ConditionalWriteUnsupportedError extends Error {
	constructor(detail: string) {
		super(
			`object store does not enforce create-if-absent writes (${detail}). The snapshot ` +
				'commit protocol relies on it to serialize writers; without it, two writers can ' +
				'silently overwrite one another. Backblaze B2 has no conditional write in either ' +
				"API; on Google Cloud Storage set conditionalWrite: 'gcs-generation'.",
		);
		this.name = 'ConditionalWriteUnsupportedError';
	}
}

async function collect(body: unknown): Promise<Uint8Array> {
	const stream = body as { transformToByteArray?: () => Promise<Uint8Array> };
	if (typeof stream.transformToByteArray === 'function') return stream.transformToByteArray();
	const chunks: Uint8Array[] = [];
	for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(c);
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

function isNotFound(e: unknown): boolean {
	const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
	return status === 404 || (e as { name?: string }).name === 'NoSuchKey';
}

function isPreconditionFailed(e: unknown): boolean {
	const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
	// 412 is the documented failure. 409 ConditionalRequestConflict is also documented on
	// S3 when a concurrent delete lands mid-write; both mean "did not create, try again".
	return status === 412 || status === 409;
}

export class S3ObjectStore implements ObjectStore {
	private readonly s3: S3Client;
	private readonly bucket: string;
	private readonly prefix: string;
	private readonly mode: 'if-none-match' | 'gcs-generation';

	constructor(opts: S3ObjectStoreOptions) {
		this.bucket = opts.bucket;
		this.prefix = opts.prefix ? opts.prefix.replace(/\/*$/, '/') : '';
		this.mode = opts.conditionalWrite ?? 'if-none-match';
		this.s3 = new S3Client({
			...(opts.region ? { region: opts.region } : {}),
			...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
			...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
			...(opts.credentials ? { credentials: opts.credentials } : {}),
		});
	}

	private k(key: string): string {
		return `${this.prefix}${key}`;
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
			return await collect(r.Body);
		} catch (e) {
			if (isNotFound(e)) return null;
			throw e;
		}
	}

	async getIfChanged(key: string, etag?: string) {
		try {
			const r = await this.s3.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: this.k(key),
					...(etag ? { IfNoneMatch: etag } : {}),
				}),
			);
			return { body: await collect(r.Body), etag: r.ETag ?? '' };
		} catch (e) {
			const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
			if (status === 304) return 'unchanged' as const;
			if (isNotFound(e)) return null;
			throw e;
		}
	}

	async put(key: string, body: Uint8Array): Promise<void> {
		await this.s3.send(
			new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: body }),
		);
	}

	async putIfAbsent(key: string, body: Uint8Array): Promise<void> {
		const cmd = new PutObjectCommand({
			Bucket: this.bucket,
			Key: this.k(key),
			Body: body,
			// S3 / R2 / MinIO / Tigris. On GCS this field is left off and the equivalent
			// rides as a raw header injected by the middleware installed in the constructor.
			...(this.mode === 'if-none-match' ? { IfNoneMatch: '*' } : {}),
		});
		if (this.mode === 'gcs-generation') {
			// The SDK has no typed field for Google's precondition, so it is injected as a raw
			// header — on THIS command only, never on the client, because an unconditional
			// `put()` must stay unconditional. `ifGenerationMatch: 0` is Google's documented
			// create-only primitive and is honored on XML-API PUT, unlike If-None-Match.
			cmd.middlewareStack.add(
				(next) => async (args) => {
					(args.request as { headers: Record<string, string> }).headers[
						'x-goog-if-generation-match'
					] = '0';
					return next(args);
				},
				{ step: 'build', name: 'graphxGcsGenerationMatch' },
			);
		}
		try {
			await this.s3.send(cmd);
		} catch (e) {
			if (isPreconditionFailed(e)) throw new ObjectExistsError(key);
			throw e;
		}
	}

	async list(prefix: string): Promise<string[]> {
		const out: string[] = [];
		let token: string | undefined;
		do {
			const r = await this.s3.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: this.k(prefix),
					...(token ? { ContinuationToken: token } : {}),
				}),
			);
			for (const o of r.Contents ?? []) {
				if (o.Key) out.push(o.Key.slice(this.prefix.length));
			}
			token = r.IsTruncated ? r.NextContinuationToken : undefined;
		} while (token);
		return out.sort();
	}

	async delete(key: string): Promise<void> {
		await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
	}
}

/**
 * Assert the store genuinely enforces create-if-absent, by doing it: write a probe key,
 * write it again, and require the second write to fail. Two providers make this necessary
 * rather than paranoid — Google's S3-compatible endpoint may ignore `If-None-Match` on PUT
 * silently, and MinIO builds from 2023–24 accepted the `*` wildcard without enforcing it.
 * A silent no-op there is not a slow path, it is two writers overwriting each other.
 */
export async function probeConditionalWrite(store: ObjectStore): Promise<void> {
	const key = `_probe/${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 16)}`;
	const one = new TextEncoder().encode('1');
	const two = new TextEncoder().encode('2');
	try {
		await store.putIfAbsent(key, one);
		let overwrote = false;
		try {
			await store.putIfAbsent(key, two);
			overwrote = true;
		} catch (e) {
			if (!(e instanceof ObjectExistsError)) throw e;
		}
		if (overwrote) {
			throw new ConditionalWriteUnsupportedError('a second putIfAbsent on a taken key succeeded');
		}
		const after = await store.get(key);
		if (after !== null && new TextDecoder().decode(after) !== '1') {
			throw new ConditionalWriteUnsupportedError('the probe object was modified by the second write');
		}
	} finally {
		await store.delete(key).catch(() => {});
	}
}
```

The `Math.random()` call is intentional here — the probe key only needs to avoid colliding with a concurrent probe, not to be cryptographically unpredictable.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/test/objstore/s3.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify against a real S3 API**

Start MinIO and point the store at it:

```bash
docker run -d --name graphx-minio -p 9100:9000 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
```

Write a scratch script and run it with `bun`, then delete it — it is a manual verification, not a committed test (the committed integration test arrives in Task 16 once there is something end-to-end to assert):

```ts
import { S3ObjectStore, probeConditionalWrite } from './packages/core/src/objstore/s3.ts';
const s = new S3ObjectStore({
	bucket: 'graphx-test',
	endpoint: 'http://127.0.0.1:9100',
	region: 'us-east-1',
	forcePathStyle: true,
	credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
});
await probeConditionalWrite(s);
console.log('CAS enforced');
```

Expected: prints `CAS enforced`. Create the bucket first via the MinIO console at `http://127.0.0.1:9100` or `mc mb`.

Then tear down: `docker rm -f graphx-minio`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/objstore/s3.ts packages/core/test/objstore/s3.test.ts
git commit -m "feat(core): add an S3 ObjectStore and a startup conditional-write probe

Create-only writes use If-None-Match: * on S3, R2, MinIO and Tigris, and
x-goog-if-generation-match: 0 on Google's S3-compatible endpoint, which
documents If-None-Match for GET and HEAD only.

The probe writes a key twice and requires the second write to fail. Two
providers make that necessary rather than paranoid: GCS may ignore the S3
spelling silently, and MinIO builds from 2023-24 accepted the wildcard
without enforcing it. A silent no-op there is two writers overwriting
each other, not a slow path."
```

---

## Task 5: The manifest and the `SnapshotStore` commit protocol

This is the heart of the design: a snapshot chain where committing means claiming the next number with a create-only write. Losing that race is normal and is resolved by rebasing, not by failing.

**Files:**
- Create: `packages/core/src/objstore/manifest.ts`
- Create: `packages/core/src/objstore/snapshot.ts`
- Test: `packages/core/test/objstore/snapshot.test.ts`

**Interfaces:**
- Consumes: `ObjectStore`, `ObjectExistsError` from Task 3.
- Produces:
  - `interface TableRef { files: string[]; tombstones?: string; partition?: string }`
  - `interface Manifest { v: 1; snapshot: number; parent: number | null; committedAt: number; embDim: number; schemaHash: string; verHigh: number; seqHigh: number; tables: Record<string, TableRef>; indexes: Record<string, Record<string, string[]>> }`
  - `function snapshotKey(n: number): string` — zero-padded to 8 digits, e.g. `snapshots/00000042.json`
  - `function parseManifest(bytes: Uint8Array): Manifest`, `function serializeManifest(m: Manifest): Uint8Array`
  - `function emptyManifest(embDim: number, schemaHash: string): Manifest` — snapshot 0, no tables
  - `class SnapshotStore` with constructor `(store: ObjectStore)` and methods `resolveHead(): Promise<Manifest | null>`, `read(n: number): Promise<Manifest | null>`, `commit(base: Manifest | null, build: (base: Manifest | null) => Promise<Manifest>): Promise<Manifest>`
  - `const MAX_COMMIT_ATTEMPTS = 50`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/objstore/snapshot.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { emptyManifest, type Manifest, snapshotKey } from '../../src/objstore/manifest.ts';
import { MemoryObjectStore } from '../../src/objstore/memory.ts';
import { SnapshotStore } from '../../src/objstore/snapshot.ts';

function bump(base: Manifest | null): Manifest {
	const parent = base?.snapshot ?? -1;
	return {
		...(base ?? emptyManifest(768, 'h')),
		snapshot: parent + 1,
		parent: base ? base.snapshot : null,
		committedAt: 1,
		verHigh: (base?.verHigh ?? 0) + 1,
	};
}

describe('SnapshotStore', () => {
	test('snapshotKey zero-pads to eight digits', () => {
		expect(snapshotKey(0)).toBe('snapshots/00000000.json');
		expect(snapshotKey(42)).toBe('snapshots/00000042.json');
	});

	test('resolveHead returns null on an empty bucket', async () => {
		expect(await new SnapshotStore(new MemoryObjectStore()).resolveHead()).toBeNull();
	});

	test('commit writes snapshot 0 and makes it resolvable', async () => {
		const s = new SnapshotStore(new MemoryObjectStore());
		const m = await s.commit(null, async (b) => bump(b));
		expect(m.snapshot).toBe(0);
		expect(m.parent).toBeNull();
		expect((await s.resolveHead())?.snapshot).toBe(0);
	});

	test('successive commits chain by parent', async () => {
		const s = new SnapshotStore(new MemoryObjectStore());
		await s.commit(null, async (b) => bump(b));
		const second = await s.commit(await s.resolveHead(), async (b) => bump(b));
		expect(second.snapshot).toBe(1);
		expect(second.parent).toBe(0);
		expect(second.verHigh).toBe(2);
	});

	test('resolveHead probes forward past a stale _head pointer', async () => {
		const store = new MemoryObjectStore();
		const s = new SnapshotStore(store);
		await s.commit(null, async (b) => bump(b));
		const stale = await store.get('_head');
		await s.commit(await s.resolveHead(), async (b) => bump(b));
		// Rewind _head to its snapshot-0 value; resolveHead must still find snapshot 1.
		await store.put('_head', stale as Uint8Array);
		expect((await s.resolveHead())?.snapshot).toBe(1);
	});

	test('a losing writer rebases onto the winner rather than failing', async () => {
		const store = new MemoryObjectStore();
		const a = new SnapshotStore(store);
		const b = new SnapshotStore(store);
		await a.commit(null, async (m) => bump(m));
		const base = await a.resolveHead();

		let bBuilds = 0;
		const [ra, rb] = await Promise.all([
			a.commit(base, async (m) => bump(m)),
			b.commit(base, async (m) => {
				bBuilds++;
				return bump(m);
			}),
		]);

		const numbers = [ra.snapshot, rb.snapshot].sort();
		expect(numbers).toEqual([1, 2]);
		// The loser re-ran its build against the winner's manifest.
		expect(bBuilds).toBeGreaterThanOrEqual(1);
		expect((await a.resolveHead())?.snapshot).toBe(2);
	});

	test('a build that throws leaves the chain untouched', async () => {
		const s = new SnapshotStore(new MemoryObjectStore());
		await s.commit(null, async (b) => bump(b));
		await expect(
			s.commit(await s.resolveHead(), async () => {
				throw new Error('build failed');
			}),
		).rejects.toThrow('build failed');
		expect((await s.resolveHead())?.snapshot).toBe(0);
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/objstore/snapshot.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write `manifest.ts`**

```ts
/**
 * The snapshot manifest — the only mutable-by-appending thing in the bucket, and it is
 * mutable only in the sense that each commit writes a NEW numbered manifest. Every
 * manifest is immutable once written, which is what lets readers pin one and lets the
 * local file cache skip invalidation entirely.
 */

/** One logical table's physical files. `files` is a list so live can be base + deltas. */
export interface TableRef {
	/** Content-addressed object keys, e.g. `data/<sha256>.parquet`. Read as one relation. */
	files: string[];
	/** Optional key of a Parquet file of ids removed from `files` (live-table deletes). */
	tombstones?: string;
	/** Hive partition column for history tables, e.g. `vt_month`. */
	partition?: string;
}

export interface Manifest {
	v: 1;
	/** Monotonic snapshot number. The object key is derived from it, not stored beside it. */
	snapshot: number;
	parent: number | null;
	committedAt: number;
	/** Embedding width baked into `emb`. Read by `readEmbDim` instead of probing the catalog. */
	embDim: number;
	/**
	 * Covers the embedding dimension and every declared constraint. A writer whose in-memory
	 * schema hashes differently refuses to commit, which catches two application versions with
	 * different `defineGraphSchema` output writing to one bucket.
	 */
	schemaHash: string;
	/** Allocation high-water marks. The writer allocates from these, never from a live
	 *  sequence — DuckDB sequences are non-transactional, so an aborted commit would burn
	 *  values and reorder them, and `seq` order IS commit order in this design. */
	verHigh: number;
	seqHigh: number;
	tables: Record<string, TableRef>;
	/** `fts_live`, `fts_history`, `ann_live` → their component file lists. */
	indexes: Record<string, Record<string, string[]>>;
}

/** Where `_head` lives. A hint only — `resolveHead` probes forward past a stale value. */
export const HEAD_KEY = '_head';

/** Zero-padded so a lexicographic `list()` is also numeric order. */
export function snapshotKey(n: number): string {
	return `snapshots/${String(n).padStart(8, '0')}.json`;
}

export function serializeManifest(m: Manifest): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(m));
}

export function parseManifest(bytes: Uint8Array): Manifest {
	const m = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
	if (m.v !== 1) throw new Error(`manifest: unsupported version ${m.v}`);
	return m;
}

/** The starting point for a brand-new namespace: no tables, no indexes, nothing allocated. */
export function emptyManifest(embDim: number, schemaHash: string): Manifest {
	return {
		v: 1,
		snapshot: 0,
		parent: null,
		committedAt: 0,
		embDim,
		schemaHash,
		verHigh: 0,
		seqHigh: 0,
		tables: {},
		indexes: {},
	};
}
```

- [ ] **Step 4: Write `snapshot.ts`**

```ts
import {
	HEAD_KEY,
	type Manifest,
	parseManifest,
	serializeManifest,
	snapshotKey,
} from './manifest.ts';
import { ObjectExistsError, type ObjectStore } from './store.ts';

/** Matches graph.ts's WRITE_MAX_RETRIES — one contention budget across the codebase. */
export const MAX_COMMIT_ATTEMPTS = 50;

/**
 * The snapshot chain and its commit protocol.
 *
 * A commit claims `snapshots/{n+1}.json` with a create-only write. Whoever wins owns that
 * number; everyone else refetches, rebuilds against the winner, and tries again. That is
 * the entire concurrency control — no lock service, no catalog, no lease. It works because
 * the object store's create-if-absent is linearizable and every data object is
 * content-addressed, so a losing writer's uploads are inert rather than damaging.
 */
export class SnapshotStore {
	constructor(private readonly store: ObjectStore) {}

	/** Read one manifest by number, or null when it does not exist. */
	async read(n: number): Promise<Manifest | null> {
		const bytes = await this.store.get(snapshotKey(n));
		return bytes ? parseManifest(bytes) : null;
	}

	/**
	 * The current head. `_head` is a hint written best-effort after a successful commit, so
	 * it can lag or race; this reads it and then probes forward until a number is missing.
	 * A cold or absent `_head` costs a `list()` instead.
	 */
	async resolveHead(): Promise<Manifest | null> {
		let n = await this.readHeadHint();
		if (n === null) {
			const keys = await this.store.list('snapshots/');
			if (keys.length === 0) return null;
			n = Number(keys[keys.length - 1].slice('snapshots/'.length, -'.json'.length));
		}
		let current = await this.read(n);
		if (current === null) {
			// The hint pointed past the end (a torn or rolled-back write). Fall back to listing.
			const keys = await this.store.list('snapshots/');
			if (keys.length === 0) return null;
			n = Number(keys[keys.length - 1].slice('snapshots/'.length, -'.json'.length));
			current = await this.read(n);
			if (current === null) return null;
		}
		for (;;) {
			const next = await this.read(current.snapshot + 1);
			if (next === null) return current;
			current = next;
		}
	}

	private async readHeadHint(): Promise<number | null> {
		const bytes = await this.store.get(HEAD_KEY);
		if (!bytes) return null;
		try {
			const n = (JSON.parse(new TextDecoder().decode(bytes)) as { snapshot?: number }).snapshot;
			return typeof n === 'number' ? n : null;
		} catch {
			return null;
		}
	}

	/**
	 * Commit a new snapshot. `build` receives the manifest this attempt is based on and
	 * returns the one to write — it is called once per attempt, so it must upload whatever
	 * data objects its result references BEFORE returning. Those uploads are safe to repeat:
	 * content addressing makes them idempotent, and any that end up unreferenced are swept
	 * by GC.
	 *
	 * `build` must set `snapshot` to `base.snapshot + 1` (or 0 when base is null) and
	 * `parent` accordingly; this method verifies that rather than patching it, so a builder
	 * that ignores its base fails loudly instead of writing a manifest that claims a lineage
	 * it does not have.
	 */
	async commit(
		base: Manifest | null,
		build: (base: Manifest | null) => Promise<Manifest>,
	): Promise<Manifest> {
		let current = base;
		for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
			const next = await build(current);
			const expected = current === null ? 0 : current.snapshot + 1;
			const expectedParent = current === null ? null : current.snapshot;
			// Both fields, not just the number. A manifest with the right number and a
			// wrong parent records a lineage that never happened, and nothing downstream
			// would notice — `resolveHead` navigates by number alone.
			if (next.snapshot !== expected || next.parent !== expectedParent) {
				throw new Error(
					`commit: build produced snapshot ${next.snapshot} parent ${next.parent}, expected ${expected} parent ${expectedParent} — the builder ignored its base`,
				);
			}
			try {
				await this.store.putIfAbsent(snapshotKey(next.snapshot), serializeManifest(next));
			} catch (e) {
				if (!(e instanceof ObjectExistsError)) throw e;
				// Someone else took this number. Rebase onto whatever is now head and retry.
				current = await this.resolveHead();
				continue;
			}
			// Best effort: a failure here only costs the next reader one extra probe.
			await this.store
				.put(HEAD_KEY, new TextEncoder().encode(JSON.stringify({ snapshot: next.snapshot })))
				.catch(() => {});
			return next;
		}
		throw new Error(`commit: too much contention after ${MAX_COMMIT_ATTEMPTS} attempts`);
	}
}
```

- [ ] **Step 5: Cover the branches that only fire when something is wrong**

The seven tests above all drive the happy path. These three cover the failure branches — the ones whose whole purpose is to turn a silent wrong answer into a loud one, and which are therefore never exercised by a passing protocol:

```ts
test('a build that ignores its base is rejected, not silently corrected', async () => {
	const s = new SnapshotStore(new MemoryObjectStore());
	await s.commit(null, async (b) => bump(b));
	const base = await s.resolveHead();
	// Right number, wrong parent — a lineage that never happened.
	await expect(
		s.commit(base, async (b) => ({ ...bump(b), parent: 99 })),
	).rejects.toThrow(/ignored its base/);
	// Wrong number.
	await expect(
		s.commit(base, async (b) => ({ ...bump(b), snapshot: 7 })),
	).rejects.toThrow(/ignored its base/);
	expect((await s.resolveHead())?.snapshot).toBe(0);
});

test('a corrupt _head falls back to listing rather than throwing', async () => {
	const store = new MemoryObjectStore();
	const s = new SnapshotStore(store);
	await s.commit(null, async (b) => bump(b));
	await store.put('_head', new TextEncoder().encode('{not json'));
	expect((await s.resolveHead())?.snapshot).toBe(0);
});

test('a _head pointing past the end falls back to listing', async () => {
	const store = new MemoryObjectStore();
	const s = new SnapshotStore(store);
	await s.commit(null, async (b) => bump(b));
	await store.put('_head', new TextEncoder().encode(JSON.stringify({ snapshot: 99 })));
	expect((await s.resolveHead())?.snapshot).toBe(0);
});
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/core/test/objstore/snapshot.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/objstore/manifest.ts packages/core/src/objstore/snapshot.ts packages/core/test/objstore/snapshot.test.ts
git commit -m "feat(core): add the snapshot manifest and its commit protocol

A commit claims snapshots/{n+1}.json with a create-only write. The winner
owns that number; losers refetch, rebuild against the winner, and retry.
That is the whole of the concurrency control - no lock service, no
catalog, no lease. It holds because create-if-absent is linearizable and
every data object is content-addressed, so a loser's uploads are inert
rather than damaging.

_head is a best-effort hint. resolveHead reads it and then probes forward,
so a stale or torn pointer costs one extra request, never correctness."
```

---

## Task 6: Content-addressed local cache

Every ANN query re-egresses the whole embedding column when served remotely — 1M×768 floats is about 3GB — and DuckDB will not help: its external file cache is in-memory, scoped to the `DuckDBInstance`, and does not survive a cold start. The cache is ours to build, and content addressing makes it trivially correct.

**Files:**
- Create: `packages/core/src/objstore/cache.ts`
- Test: `packages/core/test/objstore/cache.test.ts`

**Interfaces:**
- Consumes: `ObjectStore` from Task 3.
- Produces:
  - `function contentKey(bytes: Uint8Array): string` — `data/<sha256-hex>.parquet`
  - `class FileCache` with constructor `(store: ObjectStore, cacheDir: string)` and methods `localPath(key: string): string`, `has(key): Promise<boolean>`, `ensure(key: string): Promise<string>`, `resolve(keys: string[]): Promise<string[]>`, `putContent(bytes: Uint8Array): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/objstore/cache.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { contentKey, FileCache } from '../../src/objstore/cache.ts';
import { MemoryObjectStore } from '../../src/objstore/memory.ts';

const root = mkdtempSync(join(tmpdir(), 'graphx-cache-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const enc = (s: string) => new TextEncoder().encode(s);

describe('FileCache', () => {
	test('contentKey is stable and content-derived', () => {
		expect(contentKey(enc('abc'))).toBe(contentKey(enc('abc')));
		expect(contentKey(enc('abc'))).not.toBe(contentKey(enc('abd')));
		expect(contentKey(enc('abc'))).toMatch(/^data\/[0-9a-f]{64}\.parquet$/);
	});

	test('putContent uploads under the content key and returns it', async () => {
		const store = new MemoryObjectStore();
		const cache = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const key = await cache.putContent(enc('payload'));
		expect(key).toBe(contentKey(enc('payload')));
		expect(await store.get(key)).not.toBeNull();
	});

	test('putContent is idempotent for identical bytes', async () => {
		const store = new MemoryObjectStore();
		const cache = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const a = await cache.putContent(enc('same'));
		const b = await cache.putContent(enc('same'));
		expect(a).toBe(b);
		expect(await store.list('data/')).toHaveLength(1);
	});

	test('a writer can read back what it wrote without touching the store', async () => {
		// putContent populates the local cache too — the bytes are already in hand, and
		// re-downloading your own upload is pure waste. The store write happens first, so
		// nothing uncommitted is ever cached.
		const store = new MemoryObjectStore();
		const cache = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const key = await cache.putContent(enc('body'));
		expect(await cache.has(key)).toBe(true);
		await store.delete(key);
		expect(readFileSync(await cache.ensure(key), 'utf8')).toBe('body');
	});

	test('a reader downloads once and serves from disk afterward', async () => {
		// The download path as it actually occurs: a process with its own cache directory
		// that did not write the object.
		const store = new MemoryObjectStore();
		const writer = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const key = await writer.putContent(enc('body'));

		const reader = new FileCache(store, mkdtempSync(join(root, 'c-')));
		expect(await reader.has(key)).toBe(false);

		const path = await reader.ensure(key);
		expect(readFileSync(path, 'utf8')).toBe('body');
		expect(await reader.has(key)).toBe(true);

		// Delete from the store; a cached file must still resolve, because content-addressed
		// objects never change and so never need revalidation.
		await store.delete(key);
		expect(await reader.ensure(key)).toBe(path);
	});

	test('resolve fetches whatever is missing and preserves input order', async () => {
		const store = new MemoryObjectStore();
		const writer = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const a = await writer.putContent(enc('one'));
		const b = await writer.putContent(enc('two'));

		const reader = new FileCache(store, mkdtempSync(join(root, 'c-')));
		await reader.ensure(a);
		expect(await reader.has(b)).toBe(false);

		const paths = await reader.resolve([b, a]);
		expect(paths).toEqual([reader.localPath(b), reader.localPath(a)]);
		expect(await reader.has(b)).toBe(true);
	});

	test('ensure throws a named error for a key that is in neither place', async () => {
		const cache = new FileCache(new MemoryObjectStore(), mkdtempSync(join(root, 'c-')));
		await expect(cache.ensure('data/deadbeef.parquet')).rejects.toThrow(/not found/);
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/objstore/cache.test.ts`
Expected: FAIL — `cache.ts` does not exist.

- [ ] **Step 3: Write `cache.ts`**

```ts
import { createHash } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObjectStore } from './store.ts';

/**
 * The object key for a blob, derived entirely from its bytes. Content addressing buys
 * three things at once: uploads are idempotent (so a retried or duplicated PUT is a
 * no-op and a lost acknowledgement cannot corrupt anything), a losing writer's uploads
 * are inert rather than damaging, and a cached file never needs revalidation.
 */
export function contentKey(bytes: Uint8Array): string {
	return `data/${createHash('sha256').update(bytes).digest('hex')}.parquet`;
}

/**
 * A local, content-addressed mirror of the bucket's data objects.
 *
 * DuckDB will not do this for us. Its external file cache is IN-MEMORY and scoped to the
 * `DuckDBInstance` — measured at 54 requests cold, 1 HEAD warm, and full price again in a
 * second instance or a second process. Nothing survives a cold start, and every ANN query
 * served remotely re-reads the whole embedding column.
 *
 * Because the keys are content hashes, this cache has no invalidation logic and no
 * staleness window: a key's bytes are the same forever, which is also what makes
 * `validate_external_file_cache = NO_VALIDATION` sound for the reader (see duck.ts).
 */
export class FileCache {
	constructor(
		private readonly store: ObjectStore,
		private readonly cacheDir: string,
	) {}

	/** Where `key` lives (or would live) on disk. Pure — does not touch the filesystem. */
	localPath(key: string): string {
		return join(this.cacheDir, key.replace(/\//g, '_'));
	}

	async has(key: string): Promise<boolean> {
		try {
			await access(this.localPath(key));
			return true;
		} catch {
			return false;
		}
	}

	/** Upload bytes under their content key, skipping the PUT when it is already there. */
	async putContent(bytes: Uint8Array): Promise<string> {
		const key = contentKey(bytes);
		if ((await this.store.get(key)) === null) await this.store.put(key, bytes);
		await mkdir(this.cacheDir, { recursive: true });
		await this.writeAtomic(this.localPath(key), bytes);
		return key;
	}

	/** Download `key` if absent, and return its local path. */
	async ensure(key: string): Promise<string> {
		const path = this.localPath(key);
		if (await this.has(key)) return path;
		const bytes = await this.store.get(key);
		if (bytes === null) {
			throw new Error(`cache: object not found in store or cache: ${key}`);
		}
		await mkdir(this.cacheDir, { recursive: true });
		await this.writeAtomic(path, bytes);
		return path;
	}

	/** Ensure every key, in parallel, and return their local paths in the same order. */
	async resolve(keys: string[]): Promise<string[]> {
		return Promise.all(keys.map((k) => this.ensure(k)));
	}

	/**
	 * Write via a temp file and rename. A half-written cache file would be indistinguishable
	 * from a complete one to `has()`, and DuckDB would read it as a truncated Parquet.
	 */
	private async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
		const tmp = `${path}.${process.pid}.tmp`;
		await writeFile(tmp, bytes);
		await rename(tmp, path);
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/test/objstore/cache.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite and check types**

Run: `bun test --timeout 30000 && bun run type-check && bun run lint`
Expected: all green. Stage 2 adds only new modules that nothing imports yet, so nothing existing can regress.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/objstore/cache.ts packages/core/test/objstore/cache.test.ts
git commit -m "feat(core): add a content-addressed local file cache

DuckDB's external file cache is in-memory and scoped to the instance, so
nothing survives a cold start and every remote ANN query re-reads the
whole embedding column. This mirrors data objects to disk instead.

Content-addressed keys mean the cache needs no invalidation and has no
staleness window, which is also what makes NO_VALIDATION sound for the
reader later."
```

---

## Task 7: Package wiring and the DuckDB connection pool

`@duckdb/node-api` is 123MB installed, so it must stay an optional peer reachable only through the `@graphx/core/duck` subpath — exactly how `pg` is handled. The pool exists because a DuckDB connection is serialized but *shared*: two async tasks interleaving on one connection silently merge their transactions, which was demonstrated to swallow an autocommit insert into an unrelated rollback with no error raised.

**Files:**
- Modify: `packages/core/package.json` (exports, peerDependencies, peerDependenciesMeta, devDependencies)
- Modify: `bunup.config.ts` (core entry list)
- Create: `packages/core/src/duck-pool.ts`
- Test: `packages/core/test/duck-pool.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface PooledConnection { run(sql: string, values?: unknown[], types?: unknown[]): Promise<DuckResult>; release(): void }`
  - `interface DuckResult { rows: Record<string, unknown>[]; rowsChanged: number; columnNames: string[] }`
  - `class DuckPool` with constructor `(path: string, opts?: { max?: number })` and methods `acquire(): Promise<PooledConnection>`, `withConnection<T>(fn: (c: PooledConnection) => Promise<T>): Promise<T>`, `close(): Promise<void>`
  - `function isFatalInstanceError(e: unknown): boolean`

- [ ] **Step 1: Add the dependency**

Only the dependency declarations land here. The `./duck` export map and the bunup entry point at `src/duck.ts`, which Task 8 creates — wiring them now would leave `bun run build` pointing at a file that does not exist, so they move to Task 8 with the file they describe.

In `packages/core/package.json`, add to `devDependencies`:

```json
		"@duckdb/node-api": "1.5.5-r.2",
```

Add to `peerDependencies`:

```json
		"@duckdb/node-api": "^1.5.5-r.2",
```

Add to `peerDependenciesMeta`:

```json
		"@duckdb/node-api": {
			"optional": true
		},
```

Run: `bun install`
Expected: `@duckdb/node-api` resolves with a prebuilt binary for this platform. Verify: `bun -e "import('@duckdb/node-api').then(m => m.DuckDBInstance.create(':memory:')).then(() => console.log('ok'))"` prints `ok`.

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/duck-pool.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { DuckPool, isFatalInstanceError } from '../src/duck-pool.ts';

describe('DuckPool', () => {
	test('runs a query and reports column names', async () => {
		const pool = new DuckPool(':memory:');
		const r = await pool.withConnection((c) => c.run('SELECT 1 AS a, 2 AS b'));
		expect(r.rows).toEqual([{ a: 1, b: 2 }]);
		expect(r.columnNames).toEqual(['a', 'b']);
		await pool.close();
	});

	test('binds positional parameters', async () => {
		const pool = new DuckPool(':memory:');
		const r = await pool.withConnection((c) => c.run('SELECT $1::VARCHAR AS v', ['x']));
		expect(r.rows).toEqual([{ v: 'x' }]);
		await pool.close();
	});

	test('reports rowsChanged for DML', async () => {
		const pool = new DuckPool(':memory:');
		await pool.withConnection(async (c) => {
			await c.run('CREATE TABLE t(id INTEGER, v INTEGER)');
			await c.run('INSERT INTO t VALUES (1,1),(2,2),(3,3)');
			expect((await c.run('UPDATE t SET v = 9 WHERE id <= 2')).rowsChanged).toBe(2);
			expect((await c.run('UPDATE t SET v = 9 WHERE id = 99')).rowsChanged).toBe(0);
		});
		await pool.close();
	});

	test('two concurrent transactions do not merge', async () => {
		// The landmine: one connection is serialized but shared, so interleaving tasks
		// silently join transactions. The pool must hand each task its own connection.
		const pool = new DuckPool(':memory:', { max: 4 });
		await pool.withConnection((c) => c.run('CREATE TABLE t(v INTEGER)'));

		const taskA = pool.withConnection(async (c) => {
			await c.run('BEGIN');
			await c.run('INSERT INTO t VALUES (1)');
			await new Promise((r) => setTimeout(r, 20));
			await c.run('ROLLBACK');
		});
		const taskB = (async () => {
			await new Promise((r) => setTimeout(r, 5));
			await pool.withConnection((c) => c.run('INSERT INTO t VALUES (99)'));
		})();
		await Promise.all([taskA, taskB]);

		const r = await pool.withConnection((c) => c.run('SELECT v FROM t'));
		expect(r.rows).toEqual([{ v: 99 }]);
		await pool.close();
	});

	test('acquire beyond max waits for a release rather than opening more', async () => {
		const pool = new DuckPool(':memory:', { max: 1 });
		const first = await pool.acquire();
		let secondReady = false;
		const second = pool.acquire().then((c) => {
			secondReady = true;
			return c;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(secondReady).toBe(false);
		first.release();
		(await second).release();
		expect(secondReady).toBe(true);
		await pool.close();
	});

	test('close settles callers parked in the queue instead of hanging them', async () => {
		const pool = new DuckPool(':memory:', { max: 1 });
		const held = await pool.acquire();
		const parked = pool.acquire();
		await new Promise((r) => setTimeout(r, 10));
		await pool.close();
		// Must settle one way or the other. Before this fix the promise never resolved.
		await expect(parked).rejects.toThrow(/closed/);
		held.release();
	});

	test('a connection from a superseded generation is discarded, not pooled', async () => {
		const pool = new DuckPool(':memory:', { max: 1 });
		const c = await pool.acquire();
		// Simulate the FATAL path: the instance is replaced while this caller holds a
		// connection from the old generation.
		(pool as unknown as { rebuild(): void }).rebuild();
		c.release();
		// The corpse must not be handed to the next caller, and must not count toward max.
		expect((pool as unknown as { idle: unknown[] }).idle).toHaveLength(0);
		const fresh = await pool.acquire();
		expect((await fresh.run('SELECT 1 AS a')).rows).toEqual([{ a: 1 }]);
		fresh.release();
		await pool.close();
	});

	test('a freed slot reaches a waiter even with others queued behind it', async () => {
		// The slot-freeing paths — a stale-generation discard and a failed connect() —
		// wake a waiter without pushing anything to `idle`. With more than one caller
		// queued, a resumed waiter that deferred to the queue behind it would re-park and
		// nobody would ever create: every caller hanging while `open < max`. One queued
		// waiter is not enough to catch this; two are.
		const pool = new DuckPool(':memory:', { max: 1 });
		const held = await pool.acquire();
		const first = pool.acquire();
		const second = pool.acquire();
		await new Promise((r) => setTimeout(r, 10));

		// Simulate the FATAL path, then hand the corpse back: the slot frees with no
		// connection pooled.
		(pool as unknown as { rebuild(): void }).rebuild();
		held.release();

		const a = await first;
		expect((await a.run('SELECT 1 AS n')).rows).toEqual([{ n: 1 }]);
		a.release();
		const b = await second;
		expect((await b.run('SELECT 2 AS n')).rows).toEqual([{ n: 2 }]);
		b.release();
		await pool.close();
	});

	test('a same-tick arrival cannot jump a queued waiter', async () => {
		// Pushing a released connection to `idle` and waking someone to go find it leaves a
		// microtask-sized window in which a fresh acquire() takes it first. Sustained, that
		// starves the queued waiter indefinitely — verified, not theoretical. Direct handoff
		// closes the window.
		const pool = new DuckPool(':memory:', { max: 1 });
		const held = await pool.acquire();
		const order: string[] = [];
		const queued = pool.acquire().then((c) => {
			order.push('queued');
			return c;
		});
		await new Promise((r) => setTimeout(r, 10));

		// Release and immediately race a fresh caller in the same tick.
		held.release();
		const fresh = pool.acquire().then((c) => {
			order.push('fresh');
			return c;
		});

		(await queued).release();
		(await fresh).release();
		expect(order).toEqual(['queued', 'fresh']);
		await pool.close();
	});

	test('isFatalInstanceError recognizes an invalidated database', () => {
		expect(isFatalInstanceError(new Error('FATAL Error: database has been invalidated'))).toBe(
			true,
		);
		expect(isFatalInstanceError(new Error('Constraint Error: duplicate key'))).toBe(false);
	});
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-pool.test.ts`
Expected: FAIL — `duck-pool.ts` does not exist.

- [ ] **Step 4: Write `duck-pool.ts`**

```ts
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * DuckDB connection lifecycle.
 *
 * Two verified behaviors shape this module. First, a single connection is serialized but
 * SHARED: two async tasks interleaving on it silently merge their transactions — in the
 * reproduction, an autocommit INSERT on one task was swallowed into another task's
 * ROLLBACK, leaving the table empty with no error raised. So a transaction must own a
 * connection for its whole lifetime, which is what this pool provides.
 *
 * Second, an `INTERNAL Error` escalates to a FATAL that kills EVERY connection on the
 * instance, including ones opened afterward; only a fresh `DuckDBInstance` recovers. So
 * the pool can rebuild itself.
 */

export interface DuckResult {
	rows: Record<string, unknown>[];
	rowsChanged: number;
	columnNames: string[];
}

export interface PooledConnection {
	run(sql: string, values?: unknown[], types?: unknown[]): Promise<DuckResult>;
	release(): void;
}

/** A FATAL that invalidated the whole instance — recoverable only by rebuilding it. */
export function isFatalInstanceError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return /database has been invalidated|FATAL Error/i.test(msg);
}

type RawConnection = Awaited<ReturnType<DuckDBInstance['connect']>>;

/**
 * A connection tagged with the instance generation it was created against. After a FATAL
 * the instance is replaced, and every connection from the old generation is dead — but a
 * caller may still be holding one and will hand it back through the normal release path.
 * The tag is how `checkin` tells a live connection from a corpse.
 */
interface TaggedConnection {
	raw: RawConnection;
	generation: number;
}

export class DuckPool {
	private instance?: Promise<DuckDBInstance>;
	private readonly idle: TaggedConnection[] = [];
	/**
	 * Parked callers, served by DIRECT HANDOFF. `checkin` passes a live connection straight
	 * to the head of this queue rather than pushing it to `idle` and waking someone to go
	 * find it — a wake only schedules a microtask, so a fresh `acquire()` in the same tick
	 * would win the race to `idle.pop()` and could starve a queued waiter indefinitely.
	 * Resolving with `null` means "a slot freed but there is nothing to hand you" (a
	 * stale-generation discard, or a failed `connect()`), which grants the turn to create.
	 */
	private readonly waiting: Array<(c: TaggedConnection | null) => void> = [];
	/** Live connections of the CURRENT generation. Reset when the instance is replaced. */
	private open = 0;
	private generation = 0;
	private readonly max: number;
	private closed = false;

	constructor(
		private readonly path: string,
		opts: { max?: number } = {},
	) {
		this.max = opts.max ?? 4;
	}

	private getInstance(): Promise<DuckDBInstance> {
		this.instance ??= DuckDBInstance.create(this.path);
		return this.instance;
	}

	async acquire(): Promise<PooledConnection> {
		if (this.closed) throw new Error('duck pool: closed');
		const conn = await this.checkout();
		const raw = conn.raw;
		let released = false;
		return {
			run: async (sql, values, types) => {
				try {
					// `values === undefined` takes a different code path in the client (a raw
					// duckdb_query rather than prepare+bind), and that path returns the FIRST
					// SELECT's result for a multi-statement script and scrambles rowsChanged.
					// executeMultiple handles scripts; everything here is a single statement.
					const reader =
						values === undefined
							? await raw.runAndReadAll(sql)
							: await raw.runAndReadAll(sql, values as never, types as never);
					return {
						// getRowObjectsJS gives plain JS values for LIST/BLOB/DATE while leaving
						// BIGINT as bigint. graphx has no DECIMAL columns, which is the one type
						// this accessor renders lossily.
						rows: reader.getRowObjectsJS() as Record<string, unknown>[],
						rowsChanged: reader.rowsChanged,
						columnNames: reader.columnNames(),
					};
				} catch (e) {
					if (isFatalInstanceError(e)) this.rebuild();
					throw e;
				}
			},
			release: () => {
				if (released) return;
				released = true;
				this.checkin(conn);
			},
		};
	}

	/** Acquire, run, release — release happens even when `fn` throws. */
	async withConnection<T>(fn: (c: PooledConnection) => Promise<T>): Promise<T> {
		const c = await this.acquire();
		try {
			return await fn(c);
		} finally {
			c.release();
		}
	}

	private async checkout(): Promise<TaggedConnection> {
		for (;;) {
			if (this.closed) throw new Error('duck pool: closed');
			// Only a caller with nobody ahead of it may help itself. A queued waiter is
			// served by direct handoff, so a fresh arrival must not be able to take what
			// was freed for someone already in line.
			if (this.waiting.length === 0) {
				const spare = this.idle.pop();
				if (spare) return spare;
				if (this.open < this.max) return this.create();
			}
			const handed = await new Promise<TaggedConnection | null>((resolve) =>
				this.waiting.push(resolve),
			);
			// A connection handed straight over — no window in which anyone could take it.
			if (handed) return handed;
			if (this.closed) throw new Error('duck pool: closed');
			// Woken because a slot freed with nothing to pass on. We hold the turn, so we
			// may create even though callers are queued behind us; deferring to them here
			// would park us again with nobody left to act, and the pool would hang.
			if (this.open < this.max) return this.create();
		}
	}

	private async create(): Promise<TaggedConnection> {
		this.open++;
		const generation = this.generation;
		try {
			return { raw: await (await this.getInstance()).connect(), generation };
		} catch (e) {
			this.open--;
			// The slot we claimed is free again — pass the turn on rather than leaving the
			// queue parked behind a connection that never opened.
			this.grantTurn();
			throw e;
		}
	}

	/** Wake the longest-waiting caller with no connection: a slot is free, go make one. */
	private grantTurn(): void {
		this.waiting.shift()?.(null);
	}

	private checkin(c: TaggedConnection): void {
		// A connection from a superseded generation is dead — the FATAL that replaced the
		// instance killed it. Returning it to `idle` would hand a corpse to the next
		// caller, and counting it would let the pool exceed `max`.
		if (c.generation !== this.generation || this.closed) {
			closeQuietly(c.raw);
			this.grantTurn();
			return;
		}
		// Direct handoff: give it to whoever has been waiting longest. Going through
		// `idle` would open a window for a same-tick arrival to take it first.
		const next = this.waiting.shift();
		if (next) {
			next(c);
			return;
		}
		this.idle.push(c);
	}

	/**
	 * Discard the instance and every connection on it. The only recovery from a FATAL —
	 * a brand-new connection on the same instance is dead too.
	 *
	 * Connections currently checked out cannot be reclaimed here; they are neutralized by
	 * the generation bump, which makes `checkin` close them instead of pooling them.
	 */
	private rebuild(): void {
		for (const c of this.idle.splice(0)) closeQuietly(c.raw);
		this.generation++;
		this.open = 0;
		this.instance = undefined;
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const c of this.idle.splice(0)) closeQuietly(c.raw);
		this.open = 0;
		// Release everyone parked in the queue. Without this a caller waiting beyond `max`
		// when the pool closes is never resumed and its promise never settles.
		while (this.waiting.length > 0) this.grantTurn();
		const inst = this.instance;
		this.instance = undefined;
		if (inst) (await inst).closeSync();
	}
}

function closeQuietly(raw: RawConnection): void {
	try {
		raw.closeSync();
	} catch {
		/* the instance may already be dead; closing is best-effort */
	}
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/core/test/duck-pool.test.ts`
Expected: PASS, 6 tests. The "two concurrent transactions do not merge" test is the important one — if it fails with `[]` instead of `[{v: 99}]`, the pool is handing out one shared connection.

- [ ] **Step 6: Verify the peer stays optional**

Run: `grep -rn "duckdb" packages/core/src/index.ts packages/core/src/db.ts`
Expected: no matches. Nothing on the default import path may reference the driver. (The `dist/duck.js` build check belongs to Task 8, which creates the file that entry points at.)

Run: `bun run type-check && bun run lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/package.json packages/core/src/duck-pool.ts packages/core/test/duck-pool.test.ts bunup.config.ts bun.lock
git commit -m "feat(core): add the DuckDB connection pool and core/duck subpath

A DuckDB connection is serialized but shared, so two async tasks
interleaving on one silently merge their transactions - an autocommit
insert gets swallowed into an unrelated rollback with no error raised. A
transaction therefore needs a connection to itself, which is what the
pool provides.

The pool also rebuilds its instance on a FATAL: an INTERNAL error
invalidates every connection on the database, including ones opened
afterward, and only a fresh instance recovers.

@duckdb/node-api is ~123MB installed, so it ships as an optional peer
behind the core/duck subpath, exactly as pg does."
```

---

## Task 8: `DuckClient` — the `DbClient` implementation

This is `pg.ts`'s counterpart. Read `packages/core/src/pg.ts` first; this file mirrors its structure, and the differences are all defenses against verified DuckDB behaviors.

**Files:**
- Create: `packages/core/src/duck-value.ts`
- Create: `packages/core/src/duck.ts`
- Modify: `packages/core/src/db.ts` (register a third driver factory)
- Test: `packages/core/test/duck-client.test.ts`

**Interfaces:**
- Consumes: `DuckPool`, `PooledConnection` from Task 7; `Dialect` from Task 1.
- Produces:
  - `function normalizeRow(row: Record<string, unknown>): SqlRow` — bigint → number where safe
  - `function embParam(vec: number[]): string` — the JSON form bound for an embedding
  - `interface DuckClientOptions { path?: string; poolMax?: number }`
  - `class DuckClient implements DbClient` with `readonly dialect = 'duckdb'`, plus `end(): Promise<void>`
  - `function createDuckClient(opts?: DuckClientOptions): DuckClient`
  - `registerDuckDriver(factory)` added to `db.ts`, mirroring `registerPgDriver`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/duck-client.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { embParam, normalizeRow } from '../src/duck-value.ts';

describe('duck value marshalling', () => {
	test('bigint columns come back as numbers', () => {
		expect(normalizeRow({ ver: 42n, id: 'x' })).toEqual({ ver: 42, id: 'x' });
	});

	test('a bigint beyond Number.MAX_SAFE_INTEGER is preserved as bigint', () => {
		const big = 9007199254740993n;
		expect(normalizeRow({ n: big }).n).toBe(big);
	});

	test('the FOREVER sentinel survives normalization as a number', () => {
		expect(normalizeRow({ valid_to: 8640000000000000n }).valid_to).toBe(8640000000000000);
	});

	test('embParam produces a JSON array string', () => {
		expect(embParam([1, 0.5, 0.25])).toBe('[1,0.5,0.25]');
	});
});

describe('DuckClient', () => {
	test('execute returns rows and rowsAffected', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER, v TEXT)');
		const ins = await c.execute({ sql: 'INSERT INTO t VALUES (?, ?)', args: [1, 'a'] });
		expect(ins.rowsAffected).toBe(1);
		const sel = await c.execute('SELECT id, v FROM t');
		expect(sel.rows).toEqual([{ id: 1, v: 'a' }]);
		await c.end();
	});

	test('batch is atomic — a failing statement rolls the whole batch back', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)');
		await expect(
			c.batch(
				[
					{ sql: 'INSERT INTO t VALUES (?)', args: [1] },
					{ sql: 'INSERT INTO t VALUES (?)', args: [1] },
				],
				'write',
			),
		).rejects.toThrow();
		expect((await c.execute('SELECT count(*) AS n FROM t')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('an interactive transaction commits', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER)');
		const tx = await c.transaction('write');
		await tx.execute({ sql: 'INSERT INTO t VALUES (?)', args: [7] });
		await tx.commit();
		expect(tx.closed).toBe(true);
		expect((await c.execute('SELECT id FROM t')).rows).toEqual([{ id: 7 }]);
		await c.end();
	});

	test('commit on an aborted transaction throws instead of silently discarding', async () => {
		// DuckDB's COMMIT resolves successfully on an aborted transaction and drops the
		// writes. An adapter that reported that as durable would lie to its caller.
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)');
		const tx = await c.transaction('write');
		await tx.execute({ sql: 'INSERT INTO t VALUES (?)', args: [1] });
		await expect(tx.execute({ sql: 'INSERT INTO t VALUES (?)', args: [1] })).rejects.toThrow();
		await expect(tx.commit()).rejects.toThrow(/aborted/i);
		expect((await c.execute('SELECT count(*) AS n FROM t')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('rowsAffected drives a conditional-close compare-and-swap', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE v(id TEXT, valid_to BIGINT)');
		await c.execute({ sql: 'INSERT INTO v VALUES (?, ?)', args: ['a', 8640000000000000] });
		const won = await c.execute({
			sql: 'UPDATE v SET valid_to = ? WHERE id = ? AND valid_to = ?',
			args: [100, 'a', 8640000000000000],
		});
		expect(won.rowsAffected).toBe(1);
		const lost = await c.execute({
			sql: 'UPDATE v SET valid_to = ? WHERE id = ? AND valid_to = ?',
			args: [200, 'a', 8640000000000000],
		});
		expect(lost.rowsAffected).toBe(0);
		await c.end();
	});

	test('executeMultiple runs every statement of a DDL script', async () => {
		const c = createDuckClient();
		await c.executeMultiple(`
			CREATE TABLE a(id INTEGER);
			CREATE TABLE b(id INTEGER);
			INSERT INTO a VALUES (1);
		`);
		expect((await c.execute('SELECT count(*) AS n FROM a')).rows[0]?.n).toBe(1);
		expect((await c.execute('SELECT count(*) AS n FROM b')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('an embedding round-trips bit-exactly through the JSON binding', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE e(id TEXT, emb FLOAT[])');
		const vec = [1 / 3, 1e-8, -2.5e-30, 0.1];
		await c.execute({
			sql: `INSERT INTO e VALUES (?, from_json(?, '["FLOAT"]'))`,
			args: ['x', embParam(vec)],
		});
		const r = await c.execute('SELECT to_json(emb) AS j FROM e');
		const back = JSON.parse(String(r.rows[0]?.j)) as number[];
		expect(back.map(Math.fround)).toEqual(vec.map(Math.fround));
		await c.end();
	});

	test('splitStatements respects literals and comments', () => {
		// Each of these would silently corrupt schema DDL if mis-split: a dropped
		// statement, a merged one, or a literal cut in half.
		expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
		expect(splitStatements("SELECT ';' AS a; SELECT 2")).toEqual([
			"SELECT ';' AS a",
			'SELECT 2',
		]);
		expect(splitStatements("SELECT 'a''b;c' AS a")).toEqual(["SELECT 'a''b;c' AS a"]);
		expect(splitStatements('SELECT 1; -- trailing; comment\nSELECT 2')).toEqual([
			'SELECT 1',
			'SELECT 2',
		]);
		expect(splitStatements('-- lone; comment\nSELECT 1')).toEqual(['SELECT 1']);
		expect(splitStatements('SELECT 1; /* block; comment */ SELECT 2')).toEqual([
			'SELECT 1',
			'SELECT 2',
		]);
		expect(splitStatements('  ;; \n')).toEqual([]);
		expect(splitStatements('')).toEqual([]);
	});

	test('rollback discards the writes and closes the transaction', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER)');
		const tx = await c.transaction('write');
		await tx.execute({ sql: 'INSERT INTO t VALUES (?)', args: [1] });
		await tx.rollback();
		expect(tx.closed).toBe(true);
		expect((await c.execute('SELECT count(*) AS n FROM t')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('executeMultiple runs a script whose comments contain semicolons', async () => {
		// The schema DDL this splits is full of comments; a semicolon in one must not
		// truncate the script.
		const c = createDuckClient();
		await c.executeMultiple(`
			-- first; with a semicolon in the comment
			CREATE TABLE a(id INTEGER);
			/* and a block; comment */
			CREATE TABLE b(id INTEGER);
		`);
		expect((await c.execute('SELECT count(*) AS n FROM a')).rows[0]?.n).toBe(0);
		expect((await c.execute('SELECT count(*) AS n FROM b')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('the dialect tag is duckdb', () => {
		const c = createDuckClient();
		expect(c.dialect).toBe('duckdb');
		void c.end();
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-client.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write `duck-value.ts`**

```ts
import type { SqlRow } from './dialect.ts';

/**
 * DuckDB returns every BIGINT as a JS `bigint`, even for small values, and graphx's
 * temporal columns (`valid_from`, `valid_to`, `ver`, `seq`) are all BIGINT because
 * DuckDB's INTEGER is 32-bit and the FOREVER sentinel (8.64e15) overflows it. Callers
 * compare these against plain numbers, so narrow them here — the same normalization
 * Postgres already needed for its bigint-as-string returns.
 *
 * Values beyond Number.MAX_SAFE_INTEGER stay `bigint`: silently rounding them would be
 * worse than a type surprise. FOREVER itself is 8.64e15, comfortably inside the safe
 * range (2^53-1 ≈ 9.007e15).
 */
export function normalizeRow(row: Record<string, unknown>): SqlRow {
	const out: SqlRow = {};
	for (const [k, v] of Object.entries(row)) {
		out[k] =
			typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
				? Number(v)
				: v;
	}
	return out;
}

/**
 * Bind an embedding as a JSON array string, to be parsed by `from_json(?, '["FLOAT"]')`
 * or cast with `?::FLOAT[dim]`.
 *
 * NOT `listValue(vec)`: that infers the list's element type from the FIRST element alone
 * via `Number.isInteger`, so a normalized vector whose first component is exactly 0.0 or
 * 1.0 becomes INTEGER[] and every fractional component truncates to 0 — no error, just
 * destroyed data. The JSON path is structurally immune because DuckDB parses the whole
 * list, and it is bit-exact: JSON.stringify prints the shortest double that re-parses,
 * and re-narrowing to float32 recovers the original bits.
 */
export function embParam(vec: number[] | Float32Array): string {
	return JSON.stringify(Array.from(vec));
}
```

- [ ] **Step 4: Write `duck.ts`**

```ts
import process from 'node:process';
import { type DbConfig, registerDuckDriver } from './db.ts';
import type {
	DbClient,
	DbTransaction,
	SqlResult,
	SqlStatement,
	TransactionMode,
} from './dialect.ts';
import { DuckPool, type PooledConnection } from './duck-pool.ts';
import { normalizeRow } from './duck-value.ts';

/**
 * DuckDB adapter — implements the driver-neutral {@link DbClient} over a local DuckDB.
 * The counterpart of `pg.ts`, and deliberately the same shape.
 *
 * graphx's SQL uses `?` positional placeholders, which DuckDB accepts natively — so
 * unlike the Postgres adapter there is no placeholder-rewrite chokepoint here.
 * Dialect-specific SQL lives in `dialect-sql.ts` as always; this file is the wire layer
 * plus the defenses against DuckDB's silent failure modes.
 *
 * In stage 4 this client's durable state becomes a snapshot chain in an object store. At
 * this stage `path` is a local file or `:memory:`, which is what makes the existing test
 * suite runnable against it before any of the storage layer is wired in.
 */

export interface DuckClientOptions {
	/** Database path. Default `:memory:`. */
	path?: string;
	/** Max pooled connections (default 4). */
	poolMax?: number;
}

function normalize(stmt: SqlStatement): { sql: string; args: unknown[] } {
	if (typeof stmt === 'string') return { sql: stmt, args: [] };
	const args = stmt.args;
	if (args === undefined) return { sql: stmt.sql, args: [] };
	if (!Array.isArray(args)) {
		throw new Error('duck adapter: named statement args are not supported (use positional ?)');
	}
	return { sql: stmt.sql, args: args as unknown[] };
}

async function runOne(conn: PooledConnection, stmt: SqlStatement): Promise<SqlResult> {
	const { sql, args } = normalize(stmt);
	const r = args.length === 0 ? await conn.run(sql) : await conn.run(sql, args);
	return {
		rows: r.rows.map(normalizeRow),
		rowsAffected: r.rowsChanged,
		columns: r.columnNames,
	};
}

class DuckTransaction implements DbTransaction {
	closed = false;
	/**
	 * Set by the first statement that throws. DuckDB's `COMMIT` on an aborted transaction
	 * RESOLVES SUCCESSFULLY and discards every write, so a resolved commit proves nothing.
	 * Tracking abort explicitly is the only way this adapter can tell its caller the truth.
	 * (Note that only conversion, constraint, and out-of-range errors actually abort;
	 * parser, catalog, and binder errors leave the transaction live. Treating all of them
	 * as fatal costs a spurious rollback and buys an unambiguous contract.)
	 */
	private aborted = false;

	constructor(private readonly conn: PooledConnection) {}

	async execute(stmt: SqlStatement): Promise<SqlResult> {
		if (this.aborted) throw new Error('duck transaction: aborted — roll back and retry');
		try {
			return await runOne(this.conn, stmt);
		} catch (e) {
			this.aborted = true;
			throw e;
		}
	}

	async commit(): Promise<void> {
		if (this.aborted) {
			// Swallow a rollback failure: the caller needs to hear "aborted", which is the
			// actionable fact, not whatever went wrong while cleaning up after it.
			await this.rollback().catch(() => undefined);
			throw new Error('duck transaction: aborted — commit would silently discard the writes');
		}
		try {
			await this.conn.run('COMMIT');
		} finally {
			// Release even if COMMIT itself throws, or the connection leaks from the pool.
			this.finish();
		}
	}

	async rollback(): Promise<void> {
		try {
			await this.conn.run('ROLLBACK');
		} finally {
			this.finish();
		}
	}

	private finish(): void {
		if (!this.closed) {
			this.closed = true;
			this.conn.release();
		}
	}
}

export class DuckClient implements DbClient {
	readonly dialect = 'duckdb' as const;
	private readonly pool: DuckPool;
	private ended = false;

	constructor(opts: DuckClientOptions = {}) {
		this.pool = new DuckPool(opts.path ?? ':memory:', { max: opts.poolMax ?? 4 });
	}

	async execute(stmt: SqlStatement): Promise<SqlResult> {
		return this.pool.withConnection((c) => runOne(c, stmt));
	}

	/** Atomic batch — every statement in one transaction (mirrors libSQL `batch(_, 'write')`). */
	async batch(stmts: SqlStatement[], _mode?: TransactionMode): Promise<SqlResult[]> {
		return this.pool.withConnection(async (c) => {
			await c.run('BEGIN');
			try {
				const out: SqlResult[] = [];
				for (const stmt of stmts) out.push(await runOne(c, stmt));
				await c.run('COMMIT');
				return out;
			} catch (e) {
				await c.run('ROLLBACK').catch(() => {});
				throw e;
			}
		});
	}

	/**
	 * An interactive transaction takes a connection out of the pool for its whole lifetime.
	 * Sharing one would silently merge concurrent transactions — see duck-pool.ts.
	 *
	 * There is no isolation level to raise here, and none is needed: DuckDB writers are
	 * serialized by the write mutex in graph.ts (stage 4), which is what restores the
	 * conditional-close CAS that libSQL gets from BEGIN IMMEDIATE and Postgres from
	 * SERIALIZABLE.
	 */
	async transaction(_mode?: TransactionMode): Promise<DbTransaction> {
		const conn = await this.pool.acquire();
		try {
			await conn.run('BEGIN');
		} catch (e) {
			conn.release();
			throw e;
		}
		return new DuckTransaction(conn);
	}

	/**
	 * Run a multi-statement DDL script. `extractStatements` + prepare/run in lockstep is
	 * mandatory: a bare `run(script)` executes everything but returns the FIRST SELECT's
	 * result when the script contains one (and the last statement's otherwise), scrambling
	 * `rowsChanged`. Lockstep is also what lets a later statement depend on an earlier
	 * one's DDL, since `prepare` binds against the live catalog.
	 */
	async executeMultiple(sql: string): Promise<void> {
		await this.pool.withConnection(async (c) => {
			for (const stmt of splitStatements(sql)) {
				await c.run(stmt);
			}
		});
	}

	/** Fire-and-forget to satisfy the synchronous `DbClient.close()`. */
	close(): void {
		void this.end();
	}

	/** Await a full pool drain (test teardown). Idempotent. */
	async end(): Promise<void> {
		if (this.ended) return;
		this.ended = true;
		await this.pool.close();
	}
}

/**
 * Split a DDL script into statements on semicolons that are genuinely statement
 * boundaries — not ones inside a string literal or a comment. The client's
 * `extractStatements` would also work, but it needs a live connection to call and this
 * keeps the split testable in isolation.
 *
 * Comments must be skipped, not merely tolerated: the schema DDL this splits is full of
 * them, and a semicolon inside one produces either a parse error (when the comment tail
 * merges into the next statement) or, worse, a silently dropped statement (when the
 * comment forms an isolated fragment between two semicolons).
 */
export function splitStatements(sql: string): string[] {
	const out: string[] = [];
	let buf = '';
	let i = 0;
	const flush = (): void => {
		if (buf.trim()) out.push(buf.trim());
		buf = '';
	};
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			i = nl === -1 ? sql.length : nl + 1;
			continue;
		}
		if (ch === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (ch === "'") {
			// Copy the literal verbatim, honouring the doubled '' escape. A semicolon in
			// here is data, not a boundary.
			buf += ch;
			i++;
			while (i < sql.length) {
				buf += sql[i];
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") {
						buf += sql[i + 1];
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		if (ch === ';') {
			flush();
			i++;
			continue;
		}
		buf += ch;
		i++;
	}
	flush();
	return out;
}

/** Construct a DuckDB {@link DbClient}. */
export function createDuckClient(opts: DuckClientOptions = {}): DuckClient {
	return new DuckClient(opts);
}

/**
 * Register the DuckDB backend with {@link getDb} as a side effect of importing this
 * module (the `core/duck` subpath). One database file per namespace, mirroring the
 * libSQL file-per-namespace model; stage 4 replaces the path with a bucket prefix.
 */
registerDuckDriver(
	(namespace: string, cfg: DbConfig): DbClient =>
		new DuckClient({
			path: cfg.duckPath ?? `${namespace}.duckdb`,
			...(cfg.poolMax !== undefined ? { poolMax: cfg.poolMax } : {}),
		}),
);
```

- [ ] **Step 4b: Wire the `./duck` subpath**

Task 7 declared the dependency but deliberately left the export map alone, because it points at `src/duck.ts` — the file you just created. Wire it now that the target exists.

In `packages/core/package.json`, add to `exports` after the `./pg` entry:

```json
		"./duck": {
			"import": {
				"types": "./dist/duck.d.ts",
				"default": "./dist/duck.js"
			}
		},
```

In `bunup.config.ts`, extend the core entry list and its comment:

```ts
	{
		name: 'core',
		root: 'packages/core',
		// `pg.ts` and `duck.ts` ship as the `core/pg` and `core/duck` subpaths: importing
		// one registers that driver with `getDb` (side effect). They stay separate entries
		// so the optional `pg` / `@duckdb/node-api` peers are only pulled in by consumers
		// who opt into those backends — `@duckdb/node-api` is ~123MB installed.
		config: {
			entry: ['src/index.ts', 'src/pg.ts', 'src/duck.ts', 'src/blob.ts'],
		},
	},
```

Verify: `bun run build` exits 0 and `packages/core/dist/duck.js` exists.

- [ ] **Step 5: Register the third driver in `db.ts`**

In `packages/core/src/db.ts`, add `duckPath` to `DbConfig`, add the factory registry beside the Postgres one, and extend `resolveDriver` and `getDb`:

```ts
export interface DbConfig {
	/** Backend selector. Default: `GRAPHX_DB_DRIVER` env, else `'libsql'`. */
	driver?: Dialect;
	// Postgres
	connectionString?: string;
	ssl?: boolean | import('node:tls').ConnectionOptions;
	poolMax?: number;
	// libSQL
	authToken?: string;
	syncUrl?: string;
	syncInterval?: number;
	// DuckDB
	/** Local database path. Default `<namespace>.duckdb`. Stage 4 adds the bucket fields. */
	duckPath?: string;
}
```

```ts
/** Builds a DuckDB {@link DbClient} for a namespace. Registered by `core/duck` on import. */
export type DuckDriverFactory = (namespace: string, cfg: DbConfig) => DbClient;
let duckFactory: DuckDriverFactory | undefined;

/**
 * Register the DuckDB adapter factory. Called as a side effect of importing the
 * `core/duck` subpath, so `@duckdb/node-api` stays an OPTIONAL peer — it is ~123MB
 * installed and is never loaded for consumers who do not opt in.
 */
export function registerDuckDriver(factory: DuckDriverFactory): void {
	duckFactory = factory;
}
```

```ts
function resolveDriver(cfg: DbConfig): Dialect {
	if (cfg.driver) return cfg.driver;
	const env = process.env.GRAPHX_DB_DRIVER;
	if (env === 'postgres' || env === 'duckdb') return env;
	return 'libsql';
}
```

In `getDb`, replace the `if (resolveDriver(cfg) === 'postgres')` block with a switch:

```ts
	const driver = resolveDriver(cfg);
	let client: DbClient;
	if (driver === 'postgres') {
		if (!pgFactory) {
			throw new Error(
				"getDb: postgres driver selected but the pg adapter is not registered — import '@graphx/core/pg'",
			);
		}
		client = pgFactory(namespace, cfg);
	} else if (driver === 'duckdb') {
		if (!duckFactory) {
			throw new Error(
				"getDb: duckdb driver selected but the duck adapter is not registered — import '@graphx/core/duck'",
			);
		}
		client = duckFactory(namespace, cfg);
	} else {
		/* the existing libSQL body, unchanged */
	}
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/core/test/duck-client.test.ts`
Expected: PASS, 12 tests. The commit-on-aborted test is the one that matters most — if it passes because `commit()` resolved, the defense is missing.

Run: `bun test --timeout 30000 && bun run type-check && bun run lint`
Expected: all green; the libSQL suite is untouched.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/duck.ts packages/core/src/duck-value.ts packages/core/src/db.ts packages/core/test/duck-client.test.ts
git commit -m "feat(core): add the DuckClient DbClient implementation

Mirrors pg.ts. DuckDB accepts ? placeholders natively, so unlike the
Postgres adapter there is no rewrite chokepoint - the differences are all
defenses against silent failure modes.

The transaction tracks abort explicitly because DuckDB's COMMIT on an
aborted transaction resolves successfully and discards every write; a
resolved commit proves nothing on its own. executeMultiple splits and
runs statements one at a time because a bare multi-statement run()
returns the first SELECT's result and scrambles rowsChanged. Embeddings
bind as JSON rather than listValue(), which infers element type from the
first element alone and truncates floats without error."
```

---

## Task 9: `duckdbSchema(dim)` and the live/history split

> **Deviation from the spec's staging, deliberate:** §15 assigns the live/history split to stage 4. It lands here instead, because it is pure DDL and writing the schema twice — once flat, then again split — would be waste. Nothing else moves.

The split is what makes the schema expressible at all. Every index in graphx is *partial* over `WHERE valid_to = 8640000000000000`, and DuckDB has no partial indexes. Putting live rows in their own table makes the predicate physical: the index scope becomes the table, and what is left is a plain index.

**Files:**
- Modify: `packages/core/src/dialect-sql.ts` (add `duckdbSchema`)
- Modify: `packages/core/src/schema.ts` (`init`, `readEmbDim` duckdb arms)
- Test: `packages/core/test/duck-schema.test.ts`

**Interfaces:**
- Consumes: `createDuckClient` from Task 8.
- Produces: `function duckdbSchema(dim?: number): string` exported from `dialect-sql.ts`. Physical tables `nv_live`, `nv_history`, `ev_live`, `ev_history`; compatibility views `node_versions` (= `nv_live UNION ALL nv_history`), `edge_versions`, `nodes`, `edges`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/duck-schema.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { init, readEmbDim } from '../src/schema.ts';

const FOREVER = 8640000000000000;

describe('duckdbSchema', () => {
	test('init creates the split tables and their compatibility views', async () => {
		const c = createDuckClient();
		await init(c, 4);
		const r = await c.execute(
			`SELECT table_name FROM duckdb_tables() UNION ALL SELECT view_name FROM duckdb_views()
			 WHERE view_name IN ('node_versions','edge_versions','nodes','edges')`,
		);
		const names = r.rows.map((x) => String(x.table_name ?? x.view_name));
		for (const t of ['nv_live', 'nv_history', 'ev_live', 'ev_history']) {
			expect(names).toContain(t);
		}
		await c.end();
	});

	test('init is idempotent', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await init(c, 4);
		await c.end();
	});

	test('node_versions unions live and history', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [1, 'n1', 'Doc', 10, FOREVER],
		});
		await c.execute({
			sql: `INSERT INTO nv_history (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [2, 'n1', 'Doc', 1, 10],
		});
		expect((await c.execute('SELECT count(*) AS n FROM node_versions')).rows[0]?.n).toBe(2);
		expect((await c.execute('SELECT count(*) AS n FROM nodes')).rows[0]?.n).toBe(1);
		await c.end();
	});

	test('the live table enforces one row per id without a partial index', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [1, 'n1', 'Doc', 10, FOREVER],
		});
		await expect(
			c.execute({
				sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
				args: [2, 'n1', 'Doc', 20, FOREVER],
			}),
		).rejects.toThrow();
		await c.end();
	});

	test('the views expose exactly the columns libSQL exposes', async () => {
		// Every query in the codebase reads these four. A column missing, renamed, or
		// reordered would break them on this backend only, silently — and no other test
		// here would notice, because they all query the schema they just created rather
		// than comparing it against the reference. Comparing the two live backends keeps
		// this self-maintaining: it fails if EITHER schema drifts.
		const duck = createDuckClient();
		await init(duck, 4);
		const lib = createClient({ url: ':memory:' });
		await init(lib, 4);
		for (const view of ['nodes', 'edges', 'node_versions', 'edge_versions']) {
			const d = await duck.execute(`SELECT * FROM ${view} LIMIT 0`);
			const l = await lib.execute(`SELECT * FROM ${view} LIMIT 0`);
			expect(d.columns).toEqual(l.columns);
		}
		lib.close();
		await duck.end();
	});

	test('ver auto-populates from the sequence when a caller omits it', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO nv_live (id, type, valid_from) VALUES (?, ?, ?)`,
			args: ['n1', 'Doc', 1],
		});
		const r = await c.execute('SELECT ver FROM nv_live');
		expect(Number(r.rows[0]?.ver)).toBeGreaterThan(0);
		await c.end();
	});

	test('readEmbDim reads the declared width back', async () => {
		const c = createDuckClient();
		await init(c, 384);
		expect(await readEmbDim(c)).toBe(384);
		await c.end();
	});

	test('init rejects a conflicting dimension', async () => {
		const c = createDuckClient();
		await init(c, 384);
		await expect(init(c, 768)).rejects.toThrow(/immutable/);
		await c.end();
	});

	test('temporal columns hold the FOREVER sentinel without overflow', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [1, 'n1', 'Doc', 1, FOREVER],
		});
		expect((await c.execute('SELECT valid_to FROM nv_live')).rows[0]?.valid_to).toBe(FOREVER);
		await c.end();
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-schema.test.ts`
Expected: FAIL — `init` throws `schema.init: duckdb not implemented yet` from Task 2.

- [ ] **Step 3: Add `duckdbSchema` to `dialect-sql.ts`**

```ts
/**
 * Full DuckDB DDL — the third sibling of {@link schema} (libSQL) and {@link postgresSchema}.
 *
 * The structural difference from both: `node_versions` and `edge_versions` are **views**
 * over a live table and a history table, rather than single tables. Every index in graphx
 * is partial over `WHERE valid_to = FOREVER` (D5), and DuckDB has no partial indexes; the
 * split makes that predicate physical, so the partial index becomes a plain index over a
 * small table and `UNIQUE(id)` on the live table enforces the one-live-row-per-id
 * invariant that libSQL and Postgres get from a partial unique index.
 *
 * Other differences, all forced:
 *  - `ver`/`seq` come from explicit SEQUENCEs — no rowid alias, no AUTOINCREMENT, no
 *    IDENTITY. The writer allocates from the manifest high-water marks rather than these
 *    at commit time (sequences are non-transactional), but the DEFAULT keeps ad-hoc SQL
 *    and the test suite working.
 *  - Temporal columns are `BIGINT`: DuckDB's INTEGER is 32-bit and FOREVER is 8.64e15.
 *  - `emb` is `FLOAT[]`, not a fixed-size `FLOAT[dim]`. Parquet cannot preserve
 *    `FLOAT[N]` — even a pyarrow fixed_size_list reads back as a variable-length list —
 *    so the storage type is the one that survives a round trip. `list_cosine_distance`
 *    accepts it directly and measured faster than casting.
 *  - No full-text objects and no ANN index: DuckDB has no triggers, its FTS extension
 *    cannot index a view, and its HNSW index cannot be partial, cannot index Parquet, and
 *    silently returns fewer rows than LIMIT under a WHERE filter. Both are built at commit
 *    time and shipped as Parquet instead (spec §10).
 */
export function duckdbSchema(dim: number = 768): string {
	const nodeCols = `
  ver          BIGINT NOT NULL DEFAULT nextval('seq_ver'),
  id           TEXT NOT NULL,
  type         TEXT NOT NULL,
  body         TEXT,
  uri          TEXT,
  content_hash TEXT,
  embed_hash   TEXT,
  content_type TEXT,
  data         TEXT NOT NULL DEFAULT '{}',
  emb          FLOAT[],
  valid_from   BIGINT NOT NULL,
  valid_to     BIGINT NOT NULL DEFAULT ${FOREVER_LIT}`;
	const edgeCols = `
  ver        BIGINT NOT NULL DEFAULT nextval('seq_ver'),
  id         TEXT NOT NULL,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  rel        TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0),
  data       TEXT NOT NULL DEFAULT '{}',
  source     TEXT,
  valid_from BIGINT NOT NULL,
  valid_to   BIGINT NOT NULL DEFAULT ${FOREVER_LIT}`;
	// The declared width is not enforceable on a FLOAT[] column, so it is recorded in a
	// side table for readEmbDim — the manifest carries the same value in stage 4.
	return `
CREATE SEQUENCE IF NOT EXISTS seq_ver START 1;
CREATE SEQUENCE IF NOT EXISTS seq_outbox START 1;

CREATE TABLE IF NOT EXISTS node_identity (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS edge_identity (id TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS graph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO graph_meta (key, value) VALUES ('emb_dim', '${dim}') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS nv_live (${nodeCols},
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS nv_history (${nodeCols},
  PRIMARY KEY (ver)
);
CREATE INDEX IF NOT EXISTS nv_hist_asof ON nv_history(id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS nv_live_type ON nv_live(type);

CREATE TABLE IF NOT EXISTS ev_live (${edgeCols},
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS ev_history (${edgeCols},
  PRIMARY KEY (ver)
);
CREATE INDEX IF NOT EXISTS ev_live_src ON ev_live(src);
CREATE INDEX IF NOT EXISTS ev_live_dst ON ev_live(dst);
CREATE INDEX IF NOT EXISTS ev_hist_src ON ev_history(src, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS ev_hist_dst ON ev_history(dst, valid_from, valid_to);

CREATE OR REPLACE VIEW node_versions AS
  SELECT * FROM nv_live UNION ALL SELECT * FROM nv_history;
CREATE OR REPLACE VIEW edge_versions AS
  SELECT * FROM ev_live UNION ALL SELECT * FROM ev_history;

CREATE OR REPLACE VIEW nodes AS
  SELECT id, type, body, uri, content_hash, embed_hash, content_type, data, emb FROM nv_live;
CREATE OR REPLACE VIEW edges AS
  SELECT id, src, dst, rel, weight, data, source FROM ev_live;

CREATE TABLE IF NOT EXISTS archival_state (
  table_name TEXT PRIMARY KEY, watermark BIGINT NOT NULL, updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_outbox (
  seq    BIGINT PRIMARY KEY DEFAULT nextval('seq_outbox'),
  op     TEXT NOT NULL,
  entity TEXT NOT NULL,
  id     TEXT NOT NULL,
  label  TEXT,
  src    TEXT,
  dst    TEXT,
  shape  TEXT NOT NULL,
  ts     BIGINT NOT NULL,
  source TEXT
);

CREATE TABLE IF NOT EXISTS trigger_cursors (
  name TEXT PRIMARY KEY, seq BIGINT NOT NULL, updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS trigger_dead_letters (
  id           TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  seq          BIGINT NOT NULL,
  event        TEXT NOT NULL,
  error        TEXT NOT NULL,
  attempts     BIGINT NOT NULL,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_sub
  ON trigger_dead_letters(subscription, created_at DESC);

CREATE TABLE IF NOT EXISTS node_analytics (
  id          TEXT PRIMARY KEY,
  pagerank    REAL,
  community   BIGINT,
  degree      BIGINT,
  computed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS na_pagerank ON node_analytics(pagerank);
CREATE INDEX IF NOT EXISTS na_community ON node_analytics(community);
CREATE INDEX IF NOT EXISTS na_degree ON node_analytics(degree);
`;
}
```

Note the deliberate omission of `REFERENCES` clauses: DuckDB's foreign-key support restricts deletes of referenced rows in ways the bitemporal close-then-insert cycle trips over, and the invariants they guard are enforced by the writer under the mutex.

- [ ] **Step 4: Add the `duckdb` arms in `schema.ts`**

Replace the `duckdb` throw in `readEmbDim` with a `graph_meta` read, and the one in `init` with the schema run:

```ts
	if (dialectOf(client) === 'duckdb') {
		const r = await client.execute(
			`SELECT value FROM graph_meta WHERE key = 'emb_dim'`,
		).catch(() => ({ rows: [] as SqlRow[] }));
		const v = r.rows[0]?.value;
		return typeof v === 'string' ? Number(v) : null;
	}
```

```ts
	if (dialectOf(client) === 'duckdb') {
		// No pragmas: FKs are not declared, there is no WAL to set, and there is no
		// lock-based contention to time out — the writer is serialized in-process.
		await client.executeMultiple(duckdbSchema(dim));
		return;
	}
```

Import `duckdbSchema` alongside the other fragments, and `SqlRow` from `./dialect.ts`.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/core/test/duck-schema.test.ts`
Expected: PASS, 7 tests.

Run: `bun test --timeout 30000 && bun run type-check && bun run lint`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/dialect-sql.ts packages/core/src/schema.ts packages/core/test/duck-schema.test.ts
git commit -m "feat(core): add the DuckDB schema with a live/history split

node_versions and edge_versions become views over a live table and a
history table. Every index in graphx is partial over valid_to = FOREVER
and DuckDB has no partial indexes; the split makes the predicate
physical, so the partial index becomes a plain index over a small table
and UNIQUE(id) on the live table enforces the one-live-row-per-id
invariant directly.

ver and seq come from sequences, temporal columns are BIGINT (DuckDB's
INTEGER is 32-bit and FOREVER is 8.64e15), and emb is FLOAT[] because
Parquet cannot preserve a fixed-size FLOAT[N]."
```

---

## Task 10: Fill in the `duckdb` fragment arms

Task 1 left every fragment throwing for `duckdb`. This fills in all of them except full-text, which needs the inverted-index builder and belongs to spec stage 5.

**Files:**
- Modify: `packages/core/src/dialect-sql.ts`
- Test: `packages/core/test/dialect-sql.test.ts` (extend), `packages/core/test/duck-fragments.test.ts` (create)

**Interfaces:**
- Consumes: `duckdbSchema` from Task 9, `createDuckClient` from Task 8.
- Produces: no new exports. Every fragment except `ftsWhere`, `ftsSeedLive`, `ftsSeedAsOf` returns SQL for `'duckdb'`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/duck-fragments.test.ts`. These run the emitted SQL rather than string-matching it, because the failure modes being guarded against are silent wrong answers, not syntax errors:

```ts
import { describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { embParam } from '../src/duck-value.ts';
import {
	annSeedsAsOf,
	annSeedsLive,
	jsonArrayRows,
	jsonEqArg,
	jsonEqExpr,
	jsonField,
	scalarMax,
} from '../src/dialect-sql.ts';
import { init } from '../src/schema.ts';

const FOREVER = 8640000000000000;

describe('duckdb fragments, executed', () => {
	test('jsonField extracts an unquoted scalar', async () => {
		const c = createDuckClient();
		const sql = `SELECT ${jsonField('duckdb', 'data', 'k')} AS v FROM (SELECT '{"k":"foo"}' AS data)`;
		expect((await c.execute(sql)).rows[0]?.v).toBe('foo');
		await c.end();
	});

	test('jsonEqExpr matches a string value — the silent-false trap', async () => {
		// json_extract returns JSON, so `= 'foo'` compares '"foo"' to 'foo' and is FALSE
		// with no error. The duckdb arm must use json_extract_string.
		const c = createDuckClient();
		const sql = `SELECT count(*) AS n FROM (SELECT '{"k":"foo"}' AS data) WHERE ${jsonEqExpr('duckdb', 'data', 'k')}`;
		const r = await c.execute({ sql, args: [jsonEqArg('duckdb', 'foo')] });
		expect(r.rows[0]?.n).toBe(1);
		await c.end();
	});

	test('jsonEqExpr matches a numeric value coerced to text', async () => {
		const c = createDuckClient();
		const sql = `SELECT count(*) AS n FROM (SELECT '{"k":7}' AS data) WHERE ${jsonEqExpr('duckdb', 'data', 'k')}`;
		const r = await c.execute({ sql, args: [jsonEqArg('duckdb', 7)] });
		expect(r.rows[0]?.n).toBe(1);
		await c.end();
	});

	test('jsonArrayRows expands to UNQUOTED ids', async () => {
		// A naive unnest(json_extract(...)) yields '"a"' with the quotes, which joins to
		// zero rows against a TEXT id column — silently, and only under real data.
		const c = createDuckClient();
		const r = await c.execute({
			sql: jsonArrayRows('duckdb'),
			args: [JSON.stringify(['a', 'b'])],
		});
		expect(r.rows.map((x) => x.id)).toEqual(['a', 'b']);
		await c.end();
	});

	test('scalarMax is the two-argument scalar form', async () => {
		const c = createDuckClient();
		const r = await c.execute(`SELECT ${scalarMax('duckdb', '3', '7')} AS m`);
		expect(r.rows[0]?.m).toBe(7);
		await c.end();
	});

	test('annSeedsAsOf excludes a candidate that is nearest but not yet valid at t', async () => {
		// The highest-risk fragment here: it combines temporal filtering, true-cosine
		// ranking, and two-phase truncation. A version of it that ignored the temporal
		// filter would return a plausible, well-ordered, WRONG answer — so the case has to
		// be built so the nearest vector is the one that must be excluded.
		const c = createDuckClient();
		await init(c, 3);
		for (const [id, vec, from] of [
			['near', [1, 0, 0], 100],
			['far', [0, 0, 1], 1],
		] as const) {
			await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: [id] });
			await c.execute({
				sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to, emb)
				      VALUES (nextval('seq_ver'), ?, 'Doc', ?, ${FOREVER}, from_json(?, '["FLOAT"]'))`,
				args: [id, from, embParam([...vec])],
			});
		}
		// As of t=50, 'near' does not exist yet — even though it is the closest vector.
		const r = await c.execute({
			sql: `WITH seeds AS (${annSeedsAsOf('duckdb')}) SELECT id FROM seeds`,
			args: [embParam([1, 0, 0]), 10, 50, 50, 5],
		});
		expect(r.rows.map((x) => x.id)).toEqual(['far']);
		await c.end();
	});

	test('annSeedsLive returns live ids ordered by cosine distance', async () => {
		const c = createDuckClient();
		await init(c, 3);
		for (const [id, vec] of [
			['near', [1, 0, 0]],
			['far', [0, 0, 1]],
		] as const) {
			await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: [id] });
			await c.execute({
				sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to, emb)
				      VALUES (nextval('seq_ver'), ?, 'Doc', 1, ${FOREVER}, from_json(?, '["FLOAT"]'))`,
				args: [id, embParam([...vec])],
			});
		}
		const r = await c.execute({
			sql: `WITH seeds AS (${annSeedsLive('duckdb')}) SELECT id FROM seeds`,
			args: [embParam([1, 0, 0]), 2],
		});
		expect(r.rows[0]?.id).toBe('near');
		await c.end();
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-fragments.test.ts`
Expected: FAIL — each fragment throws `dialect-sql: <name>(duckdb) not implemented yet`.

- [ ] **Step 3: Fill in the arms**

Replace each `case 'duckdb': return notYet(...)` with the body below. Where a fragment reuses an existing arm verbatim, say so in a comment rather than duplicating the string.

```ts
// scalarMax — DuckDB's max() is aggregate-only, same as Postgres.
case 'duckdb':
	return `GREATEST(${a}, ${b})`;

// epochIntType — DuckDB's INTEGER is 32-bit, same trap as Postgres.
case 'duckdb':
	return 'BIGINT';

// distinctSelect — DuckDB implements Postgres-compatible DISTINCT ON, and rejects
// SQLite's bare-column GROUP BY outright.
case 'duckdb':
	return { select: `SELECT DISTINCT ON (${keys}) ${cols}`, group: '' };

// jsonField — DuckDB's ->> takes a JSONPath, not a bare key, and json_extract returns
// JSON. json_extract_string is the only form that yields an unquoted scalar.
case 'duckdb':
	return `json_extract_string(${col}, '$.${key}')`;

// jsonEqExpr — text comparison, so callers bind through jsonEqArg (below).
case 'duckdb':
	return `json_extract_string(${col}, '$.${key}') = ?`;

// jsonEqArg — same text coercion as Postgres, for the same reason.
case 'duckdb':
	return value === null || value === undefined
		? value
		: typeof value === 'string'
			? value
			: String(value);

// insertOrIgnore — DuckDB accepts SQLite's OR IGNORE prefix verbatim.
case 'duckdb':
	return `INSERT OR IGNORE INTO ${table} (${columns}) VALUES ${values}`;

// jsonArrayRows — no json_each and no jsonb_array_elements_text. from_json with an
// explicit VARCHAR element type is what keeps the ids unquoted.
case 'duckdb':
	return `SELECT unnest(from_json(?, '["VARCHAR"]')) AS id`;

// embColumnType — see duckdbSchema: Parquet cannot preserve FLOAT[N].
case 'duckdb':
	return 'FLOAT[]';

// embFreshExpr / embRebindExpr — both bind the JSON array string from embParam().
case 'duckdb':
	return `from_json(?, '["FLOAT"]')`;

// embExtract — to_json renders a parseable array. A bare ::VARCHAR cast would emit
// `nan`/`inf` for non-finite floats and break JSON.parse at hybrid.ts:318.
case 'duckdb':
	return 'to_json(emb)';

// vectorIndexDDL / ftsTableDDL / ftsTriggerDDL — no ANN index, no FTS objects, no
// triggers. Both indexes are built at commit time and shipped as Parquet (spec §10).
case 'duckdb':
	return '';
```

The three ANN fragments. `min_by(id, dist, k)` returns the same top-k as `ORDER BY dist LIMIT k` while reading a remote Parquet once instead of twice, and `unnest` position supplies the rank:

```ts
// annSeedsLive — args: embedding JSON, k.
case 'duckdb':
	return `
  SELECT unnest(ids) AS id
  FROM (
    SELECT min_by(id, list_cosine_distance(emb, from_json(?, '["FLOAT"]')), ?) AS ids
    FROM nv_live
    WHERE emb IS NOT NULL
  )`;

// vecSeedLive — args: embedding JSON, k. Identical shape; the caller wants ids only.
case 'duckdb':
	return `
SELECT unnest(ids) AS id
FROM (
  SELECT min_by(id, list_cosine_distance(emb, from_json(?, '["FLOAT"]')), ?) AS ids
  FROM nv_live
  WHERE emb IS NOT NULL
)`;

// annSeedsAsOf — args: embedding JSON, over-fetch k, t, t, final k. Ranks by true
// cosine distance, which is strictly better than the libSQL arm's MIN(v.id) rowid proxy.
case 'duckdb':
	return `
  SELECT live.id AS id, live.rk AS rk
  FROM (
    SELECT id, list_cosine_distance(emb, from_json(?, '["FLOAT"]')) AS rk
    FROM nv_live
    WHERE emb IS NOT NULL
    ORDER BY rk
    LIMIT ?
  ) live
  WHERE EXISTS (
    SELECT 1 FROM node_versions h
    WHERE h.id = live.id AND h.valid_from <= ? AND ? < h.valid_to
  )
  ORDER BY rk
  LIMIT ?`;
```

Leave `ftsWhere`, `ftsSeedLive`, and `ftsSeedAsOf` throwing `notYet`. They need the inverted-index builder, which is spec stage 5.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/test/duck-fragments.test.ts`
Expected: PASS, 7 tests.

Run: `bun test --timeout 30000 && bun run type-check && bun run lint`
Expected: green — the libSQL and Postgres arms are untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dialect-sql.ts packages/core/test/duck-fragments.test.ts
git commit -m "feat(core): fill in the duckdb dialect fragments

JSON access goes through json_extract_string rather than json_extract:
json_extract returns JSON, so comparing it to a bound string is silently
false. jsonArrayRows uses from_json with an explicit VARCHAR element type
for the same reason - a naive unnest yields quoted ids that join to zero
rows.

ANN is a brute-force list_cosine_distance scan over the live table, via
min_by, which returns the same top-k as ORDER BY ... LIMIT while reading
a remote Parquet once instead of twice. There is no index: DuckDB's HNSW
cannot index a view or Parquet, is RAM-only, and silently returns fewer
rows than LIMIT under a WHERE filter.

Full-text is left unimplemented; it needs the inverted-index builder."
```

---

## Task 11: The bulk, journey, and pattern `duckdb` arms

Three call sites Task 2 left throwing. Each has a specific DuckDB hazard behind it.

**Files:**
- Modify: `packages/core/src/bulk.ts:200,238,246`
- Modify: `packages/core/src/journey.ts:104-106`
- Modify: `packages/core/src/pattern.ts:206-215,403`
- Test: `packages/core/test/duck-queries.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 8–10.
- Produces: no new exports. `bulkLoad`, `journey`, and `PatternBuilder` work against a duckdb client.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/duck-queries.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';

async function graph() {
	const client = createDuckClient();
	await init(client, 4);
	return { client, g: new Graph(client) };
}

describe('duckdb query paths', () => {
	test('a pattern .where() on a string prop matches', async () => {
		const { client, g } = await graph();
		await g.addNode({ type: 'Doc', data: { slug: 'alpha' } });
		await g.addNode({ type: 'Doc', data: { slug: 'beta' } });
		const rows = await g.match().node('d', 'Doc').where('d', 'slug', 'alpha').run();
		expect(rows).toHaveLength(1);
		await client.end();
	});

	test('a pattern .where() on a numeric prop matches', async () => {
		const { client, g } = await graph();
		await g.addNode({ type: 'Doc', data: { rank: 3 } });
		const rows = await g.match().node('d', 'Doc').where('d', 'rank', 3).run();
		expect(rows).toHaveLength(1);
		await client.end();
	});

	test('keyset pagination returns every row exactly once', async () => {
		const { client, g } = await graph();
		for (let i = 0; i < 7; i++) await g.addNode({ type: 'Doc', data: { i } });
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const r = await g.listNodes({ type: 'Doc', limit: 3, cursor });
			for (const n of r.nodes) {
				expect(seen.has(n.id)).toBe(false);
				seen.add(n.id);
			}
			if (!r.cursor) break;
			cursor = r.cursor;
		}
		expect(seen.size).toBe(7);
		await client.end();
	});

	test('bulkLoad inserts nodes and edges', async () => {
		const { client, g } = await graph();
		await g.bulkLoad({
			nodes: [
				{ id: '01AAA', type: 'Doc', data: {} },
				{ id: '01BBB', type: 'Doc', data: {} },
			],
			edges: [{ src: '01AAA', dst: '01BBB', rel: 'links' }],
		});
		expect((await g.listNodes({ type: 'Doc' })).nodes).toHaveLength(2);
		expect(await g.neighbors('01AAA')).toHaveLength(1);
		await client.end();
	});

	test('journey walks a chain', async () => {
		const { client, g } = await graph();
		const a = await g.addNode({ type: 'Doc', data: {} });
		const b = await g.addNode({ type: 'Doc', data: {} });
		const c = await g.addNode({ type: 'Doc', data: {} });
		await g.addEdge({ src: a.id, dst: b.id, rel: 'next' });
		await g.addEdge({ src: b.id, dst: c.id, rel: 'next' });
		const hops = await g.journey(a.id, { rels: ['next'], maxDepth: 3 });
		expect(hops.map((h) => h.id)).toContain(c.id);
		await client.end();
	});
});
```

Adjust the `Graph` construction, method names, and option shapes to whatever `packages/core/src/graph.ts` actually exports — read it before writing this file. The assertions above are the contract; the call syntax must match the real API.

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-queries.test.ts`
Expected: FAIL with the `not implemented yet` errors planted in Task 2.

- [ ] **Step 3: `bulk.ts` — drop the index/trigger dance**

`bulk.ts:200-203` drops `nv_emb_idx` and the FTS trigger, `:236-241` recreates them, `:247` runs an FTS `'rebuild'`, `:249` runs `ANALYZE`. On DuckDB none of those objects exist. Gate the whole sequence:

```ts
// libSQL defers the ANN index and FTS trigger across a bulk load and rebuilds after.
// Postgres has no trigger to drop. DuckDB has neither object — its ANN scan is
// index-free and its FTS index is built at commit time — so the whole bracket is skipped.
const deferIndexes = dialectOf(this.raw) === 'libsql';
```

Replace each of the four `dialectOf(...) !== 'postgres'` guards with `deferIndexes`.

- [ ] **Step 4: `journey.ts` — type the anchor parameters**

`journey.ts:104-106` projects bare `?` parameters in a recursive CTE's anchor term. DuckDB has nothing to infer a type from there and fails to bind. Add explicit casts on the duckdb arm:

```ts
const idCast = dialectOf(this.raw) === 'duckdb' ? '?::VARCHAR' : '?';
```

Use `idCast` in place of the bare `?` for every projected (as opposed to compared) parameter in the anchor SELECT. Do not change the compared ones — they take their type from the column.

- [ ] **Step 5: `pattern.ts` — json access and the keyset predicate**

`pattern.ts:206-215` builds the `.where()` predicate; it already routes through `jsonEqExpr`/`jsonEqArg`, so extend its dialect resolution to return `'duckdb'` rather than defaulting to `'libsql'`:

```ts
	private dialect(): Dialect {
		return this.raw ? dialectOf(this.raw) : 'libsql';
	}
```

That line already exists — verify it is reached rather than bypassed by an `isPg` local, and delete any such local.

`pattern.ts:403` uses a row-value keyset comparison `(a,b) > (?,?)` with untyped parameters, which is unverified on DuckDB. Switch the duckdb arm to the equivalent OR-form already written at `temporal.ts:139`:

```ts
// (a, b) > (?, ?) with untyped params is unverified on DuckDB; the OR-form is
// equivalent, and is what temporal.ts already emits for the same comparison.
const keyset =
	dialectOf(this.raw) === 'duckdb'
		? `(${a} > ? OR (${a} = ? AND ${b} > ?))`
		: `(${a}, ${b}) > (?, ?)`;
```

The OR-form binds three arguments where the row-value form binds two — thread the extra argument through at the call site, and add a test asserting no row is skipped or repeated across a page boundary (the pagination test in step 1 covers this).

- [ ] **Step 6: Run the tests**

Run: `bun test packages/core/test/duck-queries.test.ts`
Expected: PASS, 5 tests.

Run: `bun test --timeout 30000 && bun run type-check && bun run lint`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/bulk.ts packages/core/src/journey.ts packages/core/src/pattern.ts packages/core/test/duck-queries.test.ts
git commit -m "feat(core): add the duckdb arms for bulk, journey, and pattern

bulkLoad's index-and-trigger bracket is libSQL-only - DuckDB has no ANN
index to defer and no FTS trigger to drop. journey's recursive-CTE anchor
projects bare ? parameters, which DuckDB cannot type-infer, so they carry
explicit casts. pattern's row-value keyset becomes the OR-form already
used in temporal.ts, since row-value comparison with untyped parameters
is unverified on DuckDB."
```

---

## Task 12: Constraint enforcement without partial indexes

Neither constraint gets a store-level index on DuckDB, for two different reasons.

`declareUniqueNodeProp` cannot: DuckDB indexes no JSON extraction, directly or through a generated column, verified on both 1.4.4 and 1.5.5. `declareSingleValuedRel` could in principle — `src` and `rel` are real columns and `ev_live` holds exactly the live rows — but the libSQL and Postgres arms scope their unique index to *one* rel, and DuckDB has no partial indexes, so an unconditional `UNIQUE(src, rel)` on `ev_live` would silently make every rel single-valued. Both are therefore enforced in application code, which is exact because the writer is serialized.

**Files:**
- Modify: `packages/core/src/constraints.ts:62-91`
- Create: `packages/core/src/duck-constraints.ts`
- Modify: `packages/core/src/graph.ts` (call the check on the node write paths)
- Test: `packages/core/test/duck-constraints.test.ts`

**Interfaces:**
- Consumes: `DbClient`, `dialectOf`; the `graph_meta` table from Task 9.
- Produces:
  - `async function declareDuckUniqueProp(client: DbClient, type: string, prop: string): Promise<void>` — records the declaration
  - `async function assertUniqueProps(client: DbClient, type: string, data: Record<string, unknown>, excludeId?: string): Promise<void>` — throws `Error('constraint violation: …')` on a duplicate

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/duck-constraints.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';

async function graph() {
	const client = createDuckClient();
	await init(client, 4);
	return { client, g: new Graph(client) };
}

describe('duckdb constraints', () => {
	test('a declared unique prop rejects a duplicate on insert', async () => {
		const { client, g } = await graph();
		await g.declareUniqueNodeProp('Doc', 'slug');
		await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await expect(g.addNode({ type: 'Doc', data: { slug: 'a' } })).rejects.toThrow(
			/constraint violation/i,
		);
		await client.end();
	});

	test('the same value is allowed under a different type', async () => {
		const { client, g } = await graph();
		await g.declareUniqueNodeProp('Doc', 'slug');
		await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await g.addNode({ type: 'Note', data: { slug: 'a' } });
		await client.end();
	});

	test('uniqueness is over LIVE rows only — a deleted value can be reused', async () => {
		const { client, g } = await graph();
		await g.declareUniqueNodeProp('Doc', 'slug');
		const n = await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await g.deleteNode(n.id);
		await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await client.end();
	});

	test('updating a node to a taken value is rejected', async () => {
		const { client, g } = await graph();
		await g.declareUniqueNodeProp('Doc', 'slug');
		await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		const b = await g.addNode({ type: 'Doc', data: { slug: 'b' } });
		await expect(g.updateNode(b.id, { data: { slug: 'a' } })).rejects.toThrow(
			/constraint violation/i,
		);
		await client.end();
	});

	test('updating a node to its own value is allowed', async () => {
		const { client, g } = await graph();
		await g.declareUniqueNodeProp('Doc', 'slug');
		const a = await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await g.updateNode(a.id, { data: { slug: 'a', extra: 1 } });
		await client.end();
	});

	test('a single-valued rel is enforced by the live table', async () => {
		const { client, g } = await graph();
		await g.declareSingleValuedRel('owner');
		const a = await g.addNode({ type: 'Doc', data: {} });
		const b = await g.addNode({ type: 'Doc', data: {} });
		const c = await g.addNode({ type: 'Doc', data: {} });
		await g.addEdge({ src: a.id, dst: b.id, rel: 'owner' });
		await g.addEdge({ src: a.id, dst: c.id, rel: 'owner' });
		// The second write supersedes the first rather than coexisting with it.
		const live = await g.neighbors(a.id, { rels: ['owner'] });
		expect(live).toHaveLength(1);
		await client.end();
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-constraints.test.ts`
Expected: FAIL — `constraints.ts` throws `not implemented yet` for duckdb.

- [ ] **Step 3: Write `duck-constraints.ts`**

```ts
import type { DbClient } from './dialect.ts';

/**
 * Unique-prop enforcement for DuckDB.
 *
 * libSQL backs `declareUniqueNodeProp` with a partial unique index over a VIRTUAL
 * generated column; Postgres with a partial unique expression index. DuckDB can express
 * neither — it has no partial indexes at all, and no index over a JSON extraction whether
 * written directly or through a generated column (verified on 1.4.4 and 1.5.5). So the
 * check lives here.
 *
 * This is exact rather than best-effort because the writer is serialized: a single
 * in-process mutex owns all writes for a namespace (see graph.ts), so a read-then-write
 * check cannot be raced by another writer in the same process, and a writer in a
 * different process cannot commit without winning the manifest CAS. What it does NOT
 * cover is something writing to the bucket outside graphx — `graphx verify` exists for
 * that, and it is stage 7.
 */

const DECL_PREFIX = 'unique_prop:';

/** Record that (`type`, `prop`) must be unique across live nodes. Idempotent. */
export async function declareDuckUniqueProp(
	client: DbClient,
	type: string,
	prop: string,
): Promise<void> {
	await client.execute({
		sql: `INSERT OR IGNORE INTO graph_meta (key, value) VALUES (?, ?)`,
		args: [`${DECL_PREFIX}${type}:${prop}`, '1'],
	});
	// Re-check the existing data so a declaration over already-duplicated rows fails
	// loudly, the way creating a unique index over duplicates would on the other backends.
	const dupes = await client.execute({
		sql: `SELECT json_extract_string(data, '$.${prop}') AS v, count(*) AS n
		      FROM nv_live WHERE type = ? AND json_extract_string(data, '$.${prop}') IS NOT NULL
		      GROUP BY 1 HAVING count(*) > 1 LIMIT 1`,
		args: [type],
	});
	if (dupes.rows.length > 0) {
		throw new Error(
			`constraint violation: cannot declare ${type}.${prop} unique — value ${JSON.stringify(dupes.rows[0]?.v)} already appears on ${dupes.rows[0]?.n} live nodes`,
		);
	}
}

/** Every prop declared unique for `type`. */
async function declaredProps(client: DbClient, type: string): Promise<string[]> {
	const r = await client.execute({
		sql: `SELECT key FROM graph_meta WHERE key LIKE ?`,
		args: [`${DECL_PREFIX}${type}:%`],
	});
	return r.rows.map((row) => String(row.key).slice(`${DECL_PREFIX}${type}:`.length));
}

/**
 * Throw if writing `data` for a node of `type` would duplicate a declared-unique prop
 * among live rows. `excludeId` is the node being updated, whose own current row must not
 * count against it.
 */
export async function assertUniqueProps(
	client: DbClient,
	type: string,
	data: Record<string, unknown>,
	excludeId?: string,
): Promise<void> {
	for (const prop of await declaredProps(client, type)) {
		const value = data[prop];
		if (value === undefined || value === null) continue;
		const r = await client.execute({
			sql: `SELECT id FROM nv_live
			      WHERE type = ? AND json_extract_string(data, '$.${prop}') = ?
			        ${excludeId ? 'AND id <> ?' : ''}
			      LIMIT 1`,
			args: excludeId
				? [type, String(value), excludeId]
				: [type, String(value)],
		});
		if (r.rows.length > 0) {
			throw new Error(
				`constraint violation: ${type}.${prop} = ${JSON.stringify(value)} is already held by node ${r.rows[0]?.id}`,
			);
		}
	}
}
```

- [ ] **Step 4: Wire it into `constraints.ts` and `graph.ts`**

In `constraints.ts`, replace the `duckdb` throw in `declareUniqueNodeProp`:

```ts
	if (dialectOf(client) === 'duckdb') {
		await declareDuckUniqueProp(client, type, prop);
		return;
	}
```

And in `declareSingleValuedRel`. The libSQL and Postgres arms create a *partial* unique index scoped to one rel (`WHERE rel = '<rel>' AND valid_to = FOREVER`). DuckDB has no partial indexes, and an unconditional `UNIQUE(src, rel)` on `ev_live` would be wrong — it would make every rel single-valued, not just the declared one. So the declaration is recorded and the invariant is upheld by `addEdge`'s existing close-then-insert path:

```ts
	if (dialectOf(client) === 'duckdb') {
		// No partial indexes, and an unconditional UNIQUE(src, rel) would silently make
		// every rel single-valued. addEdge already closes the prior live edge for a
		// single-valued rel before inserting the new one; this records the declaration so
		// it survives a restart, the way the index does on the other two backends.
		await client.execute({
			sql: `INSERT OR IGNORE INTO graph_meta (key, value) VALUES (?, ?)`,
			args: [`single_rel:${rel}`, '1'],
		});
		return;
	}
```

Before writing this, read `graph.ts:531-591`. If that path takes its set of single-valued rels from the in-memory `defineGraphSchema` output rather than from the database, the `graph_meta` row is purely for durability across restarts and nothing else needs to read it. If it queries the database, point that query at `graph_meta` on the duckdb arm.

In `graph.ts`, call `assertUniqueProps` on the duckdb dialect only, inside `addNode` before its write batch and inside `updateNode` inside the conditional-close transaction:

```ts
if (dialectOf(this.raw) === 'duckdb') {
	await assertUniqueProps(this.raw, type, data, /* excludeId */ undefined);
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/core/test/duck-constraints.test.ts`
Expected: PASS, 7 tests.

Run: `bun test --timeout 30000 && bun run type-check && bun run lint`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/duck-constraints.ts packages/core/src/constraints.ts packages/core/src/graph.ts packages/core/test/duck-constraints.test.ts
git commit -m "feat(core): enforce unique node props in code on DuckDB

DuckDB indexes no JSON extraction, directly or through a generated
column, so declareUniqueNodeProp gets no store-level backing. The check
runs in application code instead, which is exact because the writer is
serialized - a read-then-write cannot be raced in-process, and another
process cannot commit without winning the manifest CAS.

declareSingleValuedRel needs no such treatment: src and rel are real
columns and ev_live holds exactly the live rows, so the live/history
split turns that partial index into an ordinary one."
```

---

## Task 13: Third harness arm, and the first parity measurement

This is where parity stops being a promise. The whole suite runs under `GRAPHX_TEST_DRIVER=duckdb` and the result is recorded — including the failures, which are the work list for stages 5–7.

**Files:**
- Modify: `packages/core/test/harness.ts`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/DUCKDB_SUPPORT.md`

**Interfaces:**
- Consumes: `createDuckClient` from Task 8.
- Produces: `makeTestDb()` returns a DuckDB-backed `TestDb` when `GRAPHX_TEST_DRIVER=duckdb`; `docs/DUCKDB_SUPPORT.md` records the parity number and the triage.

- [ ] **Step 1: Add the duckdb arm to `makeTestDb`**

In `packages/core/test/harness.ts`, add the import and the branch. Put it *before* the postgres branch so the if-chain reads in driver order:

```ts
import { createDuckClient, type DuckClient } from '../src/duck.ts';
```

```ts
	if (DRIVER === 'duckdb') {
		// A temp file rather than :memory:, so `sibling()` can open a second connection to
		// the same database — the concurrency suite needs two genuine connections, and an
		// in-memory DuckDB is private to its instance.
		const path = `test_${ulid()}.duckdb`;
		const main = createDuckClient({ path });
		const siblings: DuckClient[] = [];
		return {
			client: main,
			sibling: () => {
				const s = createDuckClient({ path });
				siblings.push(s);
				return s;
			},
			teardown: async () => {
				for (const s of siblings) await s.end().catch(() => {});
				await main.end().catch(() => {});
				for (const sfx of ['', '.wal']) rmSync(`${path}${sfx}`, { force: true });
			},
		};
	}
```

Extend the env wiring beside the postgres block so multi-tenant `getDb()` resolves to DuckDB too:

```ts
if (DRIVER === 'duckdb') {
	process.env.GRAPHX_DB_DRIVER = 'duckdb';
}
```

The `import { createDuckClient } from '../src/duck.ts'` is what registers the adapter, exactly as the `pg.ts` import does — it is unconditional in tests and harmless, since the package is a devDependency there.

Extend the harness helper forks for the third dialect:

```ts
export function tableExistsSql(client: DbClient, table: string): string {
	switch (dialectOf(client)) {
		case 'postgres':
			return `SELECT table_name AS name FROM information_schema.tables WHERE table_name = '${table}' AND table_schema = current_schema()`;
		case 'duckdb':
			return `SELECT table_name AS name FROM duckdb_tables() WHERE table_name = '${table}'
			        UNION ALL SELECT view_name AS name FROM duckdb_views() WHERE view_name = '${table}'`;
		default:
			return `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`;
	}
}
```

`embSql`, `embReadSql`, `jsonFieldSql`, and `insertOrIgnoreSql` need no change — they delegate to fragments that Task 10 already taught about duckdb.

- [ ] **Step 2: Run the suite under the new driver**

Run: `GRAPHX_TEST_DRIVER=duckdb bun test --timeout 30000 2>&1 | tail -40`
Expected: a mix. Record the exact pass/fail/skip counts — that number is the deliverable of this task, not a green suite.

- [ ] **Step 3: Triage every failure**

Group the failures and write `docs/DUCKDB_SUPPORT.md` in the shape of `docs/POSTGRES_SUPPORT.md` — a status block, then a table mapping failure categories to counts and to the stage that resolves each. Expected categories, from the spec:

| category | resolved by |
|---|---|
| full-text: `ftsWhere` / `ftsSeedLive` / `ftsSeedAsOf` throw `notYet` | stage 5 |
| hybrid retrieval, which fuses a lexical leg | stage 5 |
| outbox ordering and trigger-runner cursors | stage 6 |
| auth package read-modify-write idempotency | stage 6 |
| multi-tenant `getDb` suites needing a bucket per namespace | stage 4 (Task 15) |
| `p14-concurrency` — asserts lock contention that does not exist here | Task 16 rewrite |
| libSQL-internals probes | none; already skipped by `libsqlOnly` |

Any failure that does not fit one of those rows is a real bug in stages 1–3 and must be fixed before this task closes. State that explicitly in the doc.

- [ ] **Step 4: Add the CI job**

In `.github/workflows/ci.yml`, add a `test-duckdb` job modeled on the existing `test-postgres` job, minus the service container — DuckDB needs no server:

```yaml
  test-duckdb:
    name: test (DuckDB)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun test --timeout 30000
        env:
          GRAPHX_TEST_DRIVER: duckdb
```

Mark it `continue-on-error: true` for now, with a comment naming the stage that removes the flag:

```yaml
    # Stages 5-7 close the remaining gaps; until then this job reports without
    # blocking. Remove continue-on-error when docs/DUCKDB_SUPPORT.md reaches parity.
    continue-on-error: true
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/harness.ts .github/workflows/ci.yml docs/DUCKDB_SUPPORT.md
git commit -m "test(core): run the suite against DuckDB and record the parity gap

Adds the third harness arm and a CI job, then writes down exactly what
passes and what does not. Every remaining failure is triaged to the stage
that resolves it; anything that does not fit a known category is a bug in
stages 1-3, not a gap.

The CI job does not block yet - the flag comes off when
docs/DUCKDB_SUPPORT.md reaches parity."
```

---

## Task 14: Materialize a snapshot into a local DuckDB

Stage 4 begins. The client's durable state moves from a local file to a snapshot chain in a bucket. This half is the read direction.

**Files:**
- Create: `packages/core/src/duck-materialize.ts`
- Test: `packages/core/test/duck-materialize.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `TableRef` (Task 5); `FileCache` (Task 6); `DuckClient` (Task 8); `duckdbSchema` (Task 9).
- Produces:
  - `const SNAPSHOT_TABLES: readonly string[]` — every table name a manifest can carry
  - `async function materialize(client: DbClient, manifest: Manifest | null, cache: FileCache): Promise<void>` — creates the schema, then loads each table's Parquet files into the matching local table
  - `async function applyReaderSettings(client: DbClient): Promise<void>` — the `NO_VALIDATION` and httpfs setup

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/duck-materialize.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { materialize, SNAPSHOT_TABLES } from '../src/duck-materialize.ts';
import { FileCache } from '../src/objstore/cache.ts';
import { emptyManifest, type Manifest } from '../src/objstore/manifest.ts';
import { MemoryObjectStore } from '../src/objstore/memory.ts';

const root = mkdtempSync(join(tmpdir(), 'graphx-mat-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function ctx() {
	const store = new MemoryObjectStore();
	return { store, cache: new FileCache(store, mkdtempSync(join(root, 'c-'))) };
}

describe('materialize', () => {
	test('a null manifest produces an empty but complete schema', async () => {
		const { cache } = ctx();
		const c = createDuckClient();
		await materialize(c, null, cache);
		for (const t of SNAPSHOT_TABLES) {
			const r = await c.execute(`SELECT count(*) AS n FROM ${t}`);
			expect(r.rows[0]?.n).toBe(0);
		}
		await c.end();
	});

	test('rows written to Parquet come back through materialize', async () => {
		const { cache } = ctx();
		// Produce a Parquet file the way the commit path will: write it from DuckDB itself.
		const producer = createDuckClient();
		await producer.execute(
			`CREATE TABLE t AS SELECT 'n1' AS id, 'Doc' AS type, 1::BIGINT AS ver,
			 1::BIGINT AS valid_from, 8640000000000000::BIGINT AS valid_to,
			 NULL::TEXT AS body, NULL::TEXT AS uri, NULL::TEXT AS content_hash,
			 NULL::TEXT AS embed_hash, NULL::TEXT AS content_type, '{}' AS data,
			 NULL::FLOAT[] AS emb`,
		);
		const path = join(root, 'nv.parquet');
		await producer.execute(`COPY t TO '${path}' (FORMAT parquet)`);
		await producer.end();

		const key = await cache.putContent(new Uint8Array(await Bun.file(path).arrayBuffer()));
		const manifest: Manifest = {
			...emptyManifest(4, 'h'),
			tables: { nv_live: { files: [key] } },
		};

		const c = createDuckClient();
		await materialize(c, manifest, cache);
		expect((await c.execute('SELECT count(*) AS n FROM nv_live')).rows[0]?.n).toBe(1);
		expect((await c.execute('SELECT count(*) AS n FROM nodes')).rows[0]?.n).toBe(1);
		await c.end();
	});

	test('materialize is a fresh load, not an append', async () => {
		const { cache } = ctx();
		const c = createDuckClient();
		const manifest = { ...emptyManifest(4, 'h'), tables: {} };
		await materialize(c, manifest, cache);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['stale'] });
		await materialize(c, manifest, cache);
		expect((await c.execute('SELECT count(*) AS n FROM node_identity')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('the embedding dimension comes from the manifest', async () => {
		const { cache } = ctx();
		const c = createDuckClient();
		await materialize(c, { ...emptyManifest(384, 'h'), tables: {} }, cache);
		expect((await c.execute(`SELECT value FROM graph_meta WHERE key='emb_dim'`)).rows[0]?.value)
			.toBe('384');
		await c.end();
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-materialize.test.ts`
Expected: FAIL — `duck-materialize.ts` does not exist.

- [ ] **Step 3: Write `duck-materialize.ts`**

```ts
import { duckdbSchema } from './dialect-sql.ts';
import type { DbClient } from './dialect.ts';
import type { FileCache } from './objstore/cache.ts';
import type { Manifest } from './objstore/manifest.ts';

/**
 * Loading a snapshot into a local DuckDB.
 *
 * The local database is a materialization of one immutable snapshot — never the source of
 * truth. That is what lets a reader treat it as disposable and a writer treat a commit as
 * "publish this materialization".
 *
 * Files load into real TABLES rather than views over `read_parquet`, for two reasons. The
 * writer must mutate them, and views cannot be indexed or constrained — so `nv_live`'s
 * PRIMARY KEY, which is how the one-live-row-per-id invariant is enforced without a
 * partial index, would not exist.
 */

/** Every table a manifest can carry. Order matters: identity tables load before referents. */
export const SNAPSHOT_TABLES = [
	'node_identity',
	'edge_identity',
	'nv_live',
	'nv_history',
	'ev_live',
	'ev_history',
	'graph_outbox',
	'node_analytics',
	'trigger_cursors',
	'trigger_dead_letters',
	'archival_state',
	'graph_meta',
] as const;

/**
 * Reader-side DuckDB settings.
 *
 * `NO_VALIDATION` is the one that matters: it takes a warm repeat query from one HEAD
 * request to zero requests and zero bytes. It is dangerous in general — it will serve
 * stale bytes when a URL's content changes — and it is sound here for exactly one reason:
 * every data object is content-addressed, so a key's bytes never change.
 */
export async function applyReaderSettings(client: DbClient): Promise<void> {
	await client.execute(`SET validate_external_file_cache = 'NO_VALIDATION'`);
	await client.execute('SET enable_http_metadata_cache = true');
	await client.execute('SET parquet_metadata_cache = true');
}

/** SQL-literal-safe path list for `read_parquet([...])`. */
function pathList(paths: string[]): string {
	return `[${paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ')}]`;
}

/**
 * Load `manifest` into `client`, replacing whatever was there. A null manifest yields an
 * empty schema — a brand-new namespace.
 */
export async function materialize(
	client: DbClient,
	manifest: Manifest | null,
	cache: FileCache,
): Promise<void> {
	const dim = manifest?.embDim ?? 768;
	// Drop first: materialize is a load, not a merge. A stale row surviving a snapshot
	// swap would be invisible corruption.
	for (const t of [...SNAPSHOT_TABLES].reverse()) {
		await client.execute(`DROP TABLE IF EXISTS ${t}`);
	}
	await client.executeMultiple(duckdbSchema(dim));
	await applyReaderSettings(client);
	if (manifest === null) return;

	for (const table of SNAPSHOT_TABLES) {
		const ref = manifest.tables[table];
		if (!ref || ref.files.length === 0) continue;
		const paths = await cache.resolve(ref.files);
		// Column-name matching rather than positional, so a manifest written by an older
		// build with fewer columns still loads.
		await client.execute(
			`INSERT INTO ${table} BY NAME SELECT * FROM read_parquet(${pathList(paths)}, union_by_name = true)`,
		);
		if (ref.tombstones) {
			const [tomb] = await cache.resolve([ref.tombstones]);
			await client.execute(
				`DELETE FROM ${table} WHERE id IN (SELECT id FROM read_parquet('${tomb}'))`,
			);
		}
	}
	// graph_meta carries emb_dim; the manifest is authoritative, so restate it after load.
	await client.execute({
		sql: `INSERT INTO graph_meta (key, value) VALUES ('emb_dim', ?)
		      ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		args: [String(dim)],
	});
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/test/duck-materialize.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/duck-materialize.ts packages/core/test/duck-materialize.test.ts
git commit -m "feat(core): materialize a snapshot into a local DuckDB

Parquet loads into real tables rather than views over read_parquet: the
writer mutates them, and a view cannot carry nv_live's PRIMARY KEY, which
is how one-live-row-per-id is enforced without a partial index.

Sets validate_external_file_cache = NO_VALIDATION, which takes a warm
repeat query from one HEAD request to zero requests. That setting serves
stale bytes when a URL's content changes and is sound here only because
every data object is content-addressed."
```

---

## Task 15: Commit a local DuckDB back to a snapshot

The write direction, and the point at which `DuckClient` stops being a local database.

**Files:**
- Create: `packages/core/src/duck-commit.ts`
- Modify: `packages/core/src/duck.ts` (bucket-backed lifecycle)
- Modify: `packages/core/src/db.ts` (`DbConfig` bucket fields)
- Test: `packages/core/test/duck-commit.test.ts`

**Interfaces:**
- Consumes: `SnapshotStore`, `Manifest` (Task 5); `FileCache` (Task 6); `materialize`, `SNAPSHOT_TABLES` (Task 14).
- Produces:
  - `async function exportTable(client: DbClient, table: string, cache: FileCache, tmpDir: string): Promise<string | null>` — writes a table to Parquet, uploads it, returns its content key (null when the table is empty)
  - `async function buildManifest(client: DbClient, base: Manifest | null, cache: FileCache, tmpDir: string, dirty: Set<string>): Promise<Manifest>`
  - `async function commitSnapshot(client: DbClient, snapshots: SnapshotStore, cache: FileCache, tmpDir: string, base: Manifest | null, dirty: Set<string>): Promise<Manifest>`
  - `DuckClientOptions` gains `store?: ObjectStore`, `cacheDir?: string`; `DbConfig` gains `bucket`, `prefix`, `cacheDir`, `endpoint`, `region`, `snapshot`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/duck-commit.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { FileCache } from '../src/objstore/cache.ts';
import { MemoryObjectStore } from '../src/objstore/memory.ts';
import { SnapshotStore } from '../src/objstore/snapshot.ts';

const root = mkdtempSync(join(tmpdir(), 'graphx-commit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function ctx() {
	const store = new MemoryObjectStore();
	return {
		store,
		snapshots: new SnapshotStore(store),
		cache: new FileCache(store, mkdtempSync(join(root, 'c-'))),
		tmp: mkdtempSync(join(root, 't-')),
	};
}

describe('snapshot commit', () => {
	test('a client opened on an empty bucket starts at no snapshot', async () => {
		const { store } = ctx();
		const c = createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
		await c.open();
		expect(c.snapshot()).toBeNull();
		await c.end();
	});

	test('committing writes a snapshot that a second client reads back', async () => {
		const { store } = ctx();
		const dir = mkdtempSync(join(root, 'c-'));
		const writer = createDuckClient({ store, cacheDir: dir });
		await writer.open();
		await writer.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await writer.commit(new Set(['node_identity']));
		expect(writer.snapshot()?.snapshot).toBe(0);
		await writer.end();

		const reader = createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
		await reader.open();
		expect((await reader.execute('SELECT id FROM node_identity')).rows).toEqual([{ id: 'n1' }]);
		await reader.end();
	});

	test('two commits chain, and the second sees the first', async () => {
		const { store } = ctx();
		const c = createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
		await c.open();
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['a'] });
		await c.commit(new Set(['node_identity']));
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['b'] });
		const m = await c.commit(new Set(['node_identity']));
		expect(m.snapshot).toBe(1);
		expect(m.parent).toBe(0);
		expect((await c.execute('SELECT count(*) AS n FROM node_identity')).rows[0]?.n).toBe(2);
		await c.end();
	});

	test('an unchanged table reuses its file refs rather than re-uploading', async () => {
		const { store } = ctx();
		const c = createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
		await c.open();
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['a'] });
		const first = await c.commit(new Set(['node_identity']));
		const objectsAfterFirst = (await store.list('data/')).length;

		await c.execute({
			sql: `INSERT INTO archival_state VALUES (?, ?, ?)`,
			args: ['node_versions', 1, 1],
		});
		const second = await c.commit(new Set(['archival_state']));
		expect(second.tables.node_identity?.files).toEqual(first.tables.node_identity?.files);
		expect((await store.list('data/')).length).toBe(objectsAfterFirst + 1);
		await c.end();
	});

	test('identical content produces the same object key', async () => {
		const { store } = ctx();
		const a = createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
		await a.open();
		await a.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['x'] });
		const m1 = await a.commit(new Set(['node_identity']));
		await a.execute({ sql: 'DELETE FROM node_identity WHERE id = ?', args: ['x'] });
		await a.commit(new Set(['node_identity']));
		await a.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['x'] });
		const m3 = await a.commit(new Set(['node_identity']));
		expect(m3.tables.node_identity?.files).toEqual(m1.tables.node_identity?.files);
		await a.end();
	});

	test('the manifest carries the ver and seq high-water marks', async () => {
		const { store } = ctx();
		const c = createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
		await c.open();
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO nv_live (ver, id, type, valid_from) VALUES (?,?,?,?)`,
			args: [17, 'n1', 'Doc', 1],
		});
		const m = await c.commit(new Set(['node_identity', 'nv_live']));
		expect(m.verHigh).toBe(17);
		await c.end();
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-commit.test.ts`
Expected: FAIL — `DuckClient` has no `open`, `commit`, or `snapshot`.

- [ ] **Step 3: Write `duck-commit.ts`**

```ts
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DbClient } from './dialect.ts';
import { SNAPSHOT_TABLES } from './duck-materialize.ts';
import type { FileCache } from './objstore/cache.ts';
import type { Manifest, TableRef } from './objstore/manifest.ts';
import type { SnapshotStore } from './objstore/snapshot.ts';

/**
 * Publishing a local DuckDB back to the snapshot chain.
 *
 * Only DIRTY tables are re-exported; everything else carries its file refs forward
 * unchanged. That is what keeps a commit proportional to what changed rather than to the
 * size of the graph.
 *
 * Every uploaded object is keyed by its content hash, which makes the upload half of a
 * commit idempotent: a retry, a duplicate, or a lost acknowledgement all converge on the
 * same key with the same bytes. Only the manifest PUT is a race, and it is settled by
 * create-if-absent.
 */

/**
 * Write one table to Parquet, upload it, and return its content key. Returns null for an
 * empty table so the manifest records absence rather than an empty file.
 */
export async function exportTable(
	client: DbClient,
	table: string,
	cache: FileCache,
	tmpDir: string,
): Promise<string | null> {
	const count = await client.execute(`SELECT count(*) AS n FROM ${table}`);
	if (Number(count.rows[0]?.n ?? 0) === 0) return null;
	const path = join(tmpDir, `${table}.parquet`);
	// zstd and a fixed row-group size so identical content yields identical bytes, which
	// is what makes the content hash stable across writers and runs.
	await client.execute(
		`COPY (SELECT * FROM ${table} ORDER BY ALL) TO '${path.replace(/'/g, "''")}'
		 (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)`,
	);
	try {
		return await cache.putContent(new Uint8Array(await readFile(path)));
	} finally {
		await rm(path, { force: true });
	}
}

/** The next manifest: dirty tables re-exported, clean tables carried forward. */
export async function buildManifest(
	client: DbClient,
	base: Manifest | null,
	cache: FileCache,
	tmpDir: string,
	dirty: Set<string>,
): Promise<Manifest> {
	const tables: Record<string, TableRef> = {};
	for (const table of SNAPSHOT_TABLES) {
		if (!dirty.has(table) && base?.tables[table]) {
			tables[table] = base.tables[table];
			continue;
		}
		const key = await exportTable(client, table, cache, tmpDir);
		if (key) tables[table] = { files: [key] };
	}
	const high = await client.execute(
		`SELECT
		   coalesce((SELECT max(ver) FROM node_versions), 0) AS nv,
		   coalesce((SELECT max(ver) FROM edge_versions), 0) AS ev,
		   coalesce((SELECT max(seq) FROM graph_outbox), 0) AS sq`,
	);
	const row = high.rows[0] ?? {};
	const dim = await client.execute(`SELECT value FROM graph_meta WHERE key = 'emb_dim'`);
	return {
		v: 1,
		snapshot: base === null ? 0 : base.snapshot + 1,
		parent: base === null ? null : base.snapshot,
		committedAt: Date.now(),
		embDim: Number(dim.rows[0]?.value ?? 768),
		schemaHash: base?.schemaHash ?? '',
		verHigh: Math.max(Number(row.nv ?? 0), Number(row.ev ?? 0)),
		seqHigh: Number(row.sq ?? 0),
		tables,
		indexes: base?.indexes ?? {},
	};
}

/**
 * Export, upload, and claim the next snapshot number. On a lost race the whole build
 * re-runs against the winner — including the exports, which is cheap because the uploads
 * deduplicate on content.
 */
export async function commitSnapshot(
	client: DbClient,
	snapshots: SnapshotStore,
	cache: FileCache,
	tmpDir: string,
	base: Manifest | null,
	dirty: Set<string>,
): Promise<Manifest> {
	return snapshots.commit(base, (b) => buildManifest(client, b, cache, tmpDir, dirty));
}
```

Note `Date.now()` in `buildManifest` — that is the commit timestamp and belongs there.

- [ ] **Step 4: Wire the lifecycle into `duck.ts`**

Extend `DuckClientOptions` and add the three methods:

```ts
export interface DuckClientOptions {
	/** Local database path. Default `:memory:` — the whole point is that it is disposable. */
	path?: string;
	poolMax?: number;
	/** Durable backing. Without it the client is a plain local DuckDB (stage 3 behavior). */
	store?: ObjectStore;
	/** Where cached data objects live. Required when `store` is set. */
	cacheDir?: string;
	/** Pin to a specific snapshot instead of following head. */
	snapshot?: number;
}
```

```ts
	private snapshots?: SnapshotStore;
	private cache?: FileCache;
	private current: Manifest | null = null;
	private tmpDir?: string;

	/**
	 * Resolve the head snapshot and materialize it. Must be awaited before the first query
	 * when the client is bucket-backed; a local-only client is usable immediately.
	 */
	async open(): Promise<void> {
		if (!this.snapshots || !this.cache) return;
		this.current =
			this.pinned === undefined
				? await this.snapshots.resolveHead()
				: await this.snapshots.read(this.pinned);
		await materialize(this, this.current, this.cache);
	}

	/** The snapshot this client is reading, or null on an empty bucket. */
	snapshot(): Manifest | null {
		return this.current;
	}

	/** Publish the local state as the next snapshot. `dirty` names the tables that changed. */
	async commit(dirty: Set<string>): Promise<Manifest> {
		if (!this.snapshots || !this.cache || !this.tmpDir) {
			throw new Error('duck client: commit requires a store — construct with { store, cacheDir }');
		}
		this.current = await commitSnapshot(
			this,
			this.snapshots,
			this.cache,
			this.tmpDir,
			this.current,
			dirty,
		);
		return this.current;
	}
```

Add the bucket fields to `DbConfig` in `db.ts` and use them in the registered factory:

```ts
	// DuckDB
	duckPath?: string;
	/** Object-storage bucket. When set, the namespace becomes a key prefix beneath it. */
	bucket?: string;
	prefix?: string;
	cacheDir?: string;
	endpoint?: string;
	region?: string;
	/** Pin reads to one snapshot instead of following head. */
	snapshot?: number;
```

```ts
registerDuckDriver((namespace: string, cfg: DbConfig): DbClient => {
	// Namespace maps to a key prefix, the way it maps to a schema on Postgres and to a
	// file on libSQL. One bucket can hold every tenant.
	const store = cfg.bucket
		? new S3ObjectStore({
				bucket: cfg.bucket,
				prefix: `${cfg.prefix ? `${cfg.prefix}/` : ''}${namespace}`,
				...(cfg.region ? { region: cfg.region } : {}),
				...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
			})
		: undefined;
	return new DuckClient({
		...(store ? { store, cacheDir: cfg.cacheDir ?? `.graphx-cache/${namespace}` } : {}),
		...(cfg.duckPath ? { path: cfg.duckPath } : {}),
		...(cfg.snapshot !== undefined ? { snapshot: cfg.snapshot } : {}),
		...(cfg.poolMax !== undefined ? { poolMax: cfg.poolMax } : {}),
	});
});
```

`getDb` is synchronous, so it cannot await `open()`. Have `DuckClient` lazily open on first use: keep an `opened?: Promise<void>` field, start it in the constructor when `store` is set, and `await this.opened` at the top of `execute`, `batch`, `transaction`, and `executeMultiple` — the same one-shot-bootstrap pattern `PgClient.ready` already uses (`pg.ts:130,152`).

- [ ] **Step 5: Run the tests**

Run: `bun test packages/core/test/duck-commit.test.ts`
Expected: PASS, 7 tests.

Run: `bun test --timeout 30000 && bun run type-check && bun run lint`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/duck-commit.ts packages/core/src/duck.ts packages/core/src/db.ts packages/core/test/duck-commit.test.ts
git commit -m "feat(core): commit a local DuckDB back to the snapshot chain

Only dirty tables are re-exported; the rest carry their file refs
forward, so a commit costs what changed rather than what exists. Uploads
are keyed by content hash, which makes that half of a commit idempotent -
a retry, a duplicate, or a lost ack all converge on the same key. Only
the manifest PUT is a race, and create-if-absent settles it.

getDb is synchronous, so the client opens its snapshot lazily on first
use, mirroring PgClient.ready."
```

---

## Task 16: The write session, the mutex, and end-to-end verification

The last piece. A commit per mutation is untenable, and the conditional-close CAS needs a serialized writer to be a CAS at all. Both are the same mechanism.

**Files:**
- Modify: `packages/core/src/graph.ts` (write session, mutex, `isRetryableContention`)
- Modify: `packages/core/src/serve.ts:687-715` (contention → 409)
- Create: `packages/core/test/duck-e2e.test.ts`
- Modify: `packages/core/test/p14-concurrency.test.ts` (duckdb variant)
- Modify: `docs/DUCKDB_SUPPORT.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `Graph.write<T>(fn: (g: Graph) => Promise<T>): Promise<T>` — groups every mutation in `fn` into one snapshot commit; nested calls join the enclosing session.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/duck-e2e.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { Graph } from '../src/graph.ts';
import { MemoryObjectStore } from '../src/objstore/memory.ts';
import { SnapshotStore } from '../src/objstore/snapshot.ts';

const root = mkdtempSync(join(tmpdir(), 'graphx-e2e-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function client(store: MemoryObjectStore) {
	return createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
}

describe('duckdb end to end', () => {
	test('a bare mutation commits on its own', async () => {
		const store = new MemoryObjectStore();
		const c = client(store);
		const g = new Graph(c);
		await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		expect(await new SnapshotStore(store).resolveHead()).not.toBeNull();
		await c.end();
	});

	test('a write session commits exactly once', async () => {
		const store = new MemoryObjectStore();
		const c = client(store);
		const g = new Graph(c);
		await g.write(async (w) => {
			await w.addNode({ type: 'Doc', data: { slug: 'a' } });
			await w.addNode({ type: 'Doc', data: { slug: 'b' } });
			await w.addNode({ type: 'Doc', data: { slug: 'c' } });
		});
		expect((await store.list('snapshots/')).length).toBe(1);
		expect((await new SnapshotStore(store).resolveHead())?.snapshot).toBe(0);
		await c.end();
	});

	test('a write session that throws commits nothing', async () => {
		const store = new MemoryObjectStore();
		const c = client(store);
		const g = new Graph(c);
		await expect(
			g.write(async (w) => {
				await w.addNode({ type: 'Doc', data: { slug: 'a' } });
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		expect(await new SnapshotStore(store).resolveHead()).toBeNull();
		await c.end();
	});

	test('a nested write joins the outer session', async () => {
		const store = new MemoryObjectStore();
		const c = client(store);
		const g = new Graph(c);
		await g.write(async (w) => {
			await w.addNode({ type: 'Doc', data: { slug: 'a' } });
			await w.write(async (inner) => {
				await inner.addNode({ type: 'Doc', data: { slug: 'b' } });
			});
		});
		expect((await store.list('snapshots/')).length).toBe(1);
		await c.end();
	});

	test('a second reader sees a committed write', async () => {
		const store = new MemoryObjectStore();
		const w = client(store);
		const node = await new Graph(w).addNode({ type: 'Doc', data: { slug: 'a' } });
		await w.end();

		const r = client(store);
		expect((await new Graph(r).getNode(node.id))?.id).toBe(node.id);
		await r.end();
	});

	test('concurrent updates to one node keep exactly one live version', async () => {
		// The invariant p14-concurrency proves on libSQL through lock contention. Here it
		// holds because the writer is serialized by the mutex and, across processes, by the
		// manifest CAS.
		const store = new MemoryObjectStore();
		const c = client(store);
		const g = new Graph(c);
		const n = await g.addNode({ type: 'Doc', data: { v: 0 } });
		await Promise.all(
			Array.from({ length: 8 }, (_, i) => g.updateNode(n.id, { data: { v: i + 1 } })),
		);
		const live = await c.execute({
			sql: 'SELECT count(*) AS n FROM nv_live WHERE id = ?',
			args: [n.id],
		});
		expect(live.rows[0]?.n).toBe(1);
		const history = await c.execute({
			sql: 'SELECT valid_from, valid_to FROM nv_history WHERE id = ? ORDER BY valid_from',
			args: [n.id],
		});
		// Intervals must be contiguous and non-overlapping.
		for (let i = 1; i < history.rows.length; i++) {
			expect(history.rows[i]?.valid_from).toBe(history.rows[i - 1]?.valid_to);
		}
		await c.end();
	});

	test('two writers racing a commit both land, one after the other', async () => {
		const store = new MemoryObjectStore();
		const a = client(store);
		const b = client(store);
		const [ga, gb] = [new Graph(a), new Graph(b)];
		await Promise.all([
			ga.addNode({ type: 'Doc', data: { slug: 'a' } }),
			gb.addNode({ type: 'Doc', data: { slug: 'b' } }),
		]);
		const head = await new SnapshotStore(store).resolveHead();
		expect(head?.snapshot).toBe(1);
		await a.end();
		await b.end();
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/duck-e2e.test.ts`
Expected: FAIL — `Graph.write` does not exist.

- [ ] **Step 3: Add the mutex and the write session to `graph.ts`**

```ts
/**
 * Serializes every write for one client. On libSQL the writer is reserved by
 * BEGIN IMMEDIATE and on Postgres by SERIALIZABLE; DuckDB has neither, so the mutex is
 * what makes `runConditionalClose`'s `rowsAffected === 1` an actual compare-and-swap
 * rather than a check two writers can both pass. Across processes the manifest CAS plays
 * the same role.
 */
private writeChain: Promise<unknown> = Promise.resolve();

private serialize<T>(fn: () => Promise<T>): Promise<T> {
	const next = this.writeChain.then(fn, fn);
	// Keep the chain alive after a rejection, or one failed write wedges every later one.
	this.writeChain = next.catch(() => undefined);
	return next;
}
```

```ts
/** Tables a session has touched, or undefined when no session is open. */
private session?: Set<string>;

/**
 * Group every mutation in `fn` into ONE snapshot commit.
 *
 * A commit is object PUTs plus a manifest CAS, so a per-mutation commit is untenable for
 * anything but a single write. A bare `addNode()` outside a session still commits on its
 * own — the API is unchanged — but a batch of work belongs in here.
 *
 * A nested call joins the enclosing session, so the outermost one owns the commit. A body
 * that throws commits nothing: the local database is a materialization, so discarding it
 * and reloading from the last snapshot is the rollback.
 */
async write<T>(fn: (g: Graph) => Promise<T>): Promise<T> {
	if (this.session) return fn(this);
	if (dialectOf(this.raw) !== 'duckdb') return fn(this);
	const dirty = new Set<string>();
	this.session = dirty;
	try {
		const out = await fn(this);
		this.session = undefined;
		await (this.raw as DuckClient).commit(dirty);
		return out;
	} catch (e) {
		this.session = undefined;
		await (this.raw as DuckClient).reload();
		throw e;
	}
}

/** Record a table as changed, and auto-commit when no session is open. */
private async touched(...tables: string[]): Promise<void> {
	if (this.session) {
		for (const t of tables) this.session.add(t);
		return;
	}
	if (dialectOf(this.raw) === 'duckdb') {
		await (this.raw as DuckClient).commit(new Set(tables));
	}
}
```

Call `touched(...)` at the end of each mutation — `addNode` (`node_identity`, `nv_live`, `graph_outbox`), `addEdge` (`edge_identity`, `ev_live`, `ev_history`, `graph_outbox`), `updateNode` and `deleteNode` (`nv_live`, `nv_history`, `graph_outbox`), `deleteEdge` (`ev_live`, `ev_history`, `graph_outbox`), `bulkLoad` and `bulkEdges` (all six version tables plus identity).

Wrap the bodies of `runWriteBatch` and `runConditionalClose` in `this.serialize(...)`.

Add `reload()` to `DuckClient` — re-materialize the current manifest, discarding local state:

```ts
	/** Discard local state and re-materialize the current snapshot. The rollback path. */
	async reload(): Promise<void> {
		if (this.cache) await materialize(this, this.current, this.cache);
	}
```

- [ ] **Step 4: Teach `isRetryableContention` about DuckDB**

`graph.ts:297-313` matches SQLITE_BUSY and the Postgres SQLSTATEs. None of DuckDB's conflict signals match, so today every conflict would fall through `if (!isRetryableContention(e)) throw e` and reach the caller as a 500. Add them:

```ts
	// DuckDB signals a write-write conflict as a TransactionContext error with no code,
	// and the snapshot store signals a lost commit race with ObjectExistsError.
	if (e instanceof ObjectExistsError) return true;
	if (/Conflict on|transaction is aborted|TransactionContext Error/i.test(msg)) return true;
```

- [ ] **Step 5: Map contention to 409 in `serve.ts`**

`"…: too much contention"` is unmapped in `serve.ts:687-715` and falls to 500. On object storage it becomes an expected condition:

```ts
	// Retries exhausted against a contended writer. A 500 would tell the caller the server
	// is broken; 409 tells them to retry, which is what they should do.
	if (/: too much contention$/.test(msg)) return 409;
```

Add a test asserting the status alongside the existing mappings in the serve suite.

- [ ] **Step 6: Give `p14-concurrency` a duckdb variant**

Its 5 tests open 8 connections to one file and rely on write-lock contention, which does not exist here. Gate the existing bodies with `libsqlOnly`-style guards for the lock mechanics, and add a duckdb block asserting the same *invariant* through the commit protocol: N clients over one store, each committing, exactly one winner per snapshot number, and version intervals contiguous. The last two tests in `duck-e2e.test.ts` are that block — move them into `p14-concurrency.test.ts` so the invariant stays in one file.

- [ ] **Step 7: Run everything**

Run: `bun test packages/core/test/duck-e2e.test.ts`
Expected: PASS, 5 tests — the last two moved to `p14-concurrency.test.ts` in step 6.

Run: `bun test packages/core/test/p14-concurrency.test.ts`
Expected: PASS, including the two relocated invariant tests.

Run: `GRAPHX_TEST_DRIVER=duckdb bun test --timeout 30000 2>&1 | tail -40`
Expected: better than Task 13's number. Update `docs/DUCKDB_SUPPORT.md` with the new counts and re-triage. Every remaining failure must map to full-text (stage 5), events/auth (stage 6), or serving/tooling (stage 7).

Run: `bun test --timeout 30000` and `GRAPHX_TEST_DRIVER=postgres bun test --timeout 30000`
Expected: both unchanged. Stage 4 touches `graph.ts` and `serve.ts`, so this is the check that the other two backends did not regress.

Run: `bun run type-check && bun run lint`
Expected: exit 0.

- [ ] **Step 8: Verify against a real bucket**

Start MinIO as in Task 4, create the bucket, then run the end-to-end test against `S3ObjectStore` instead of `MemoryObjectStore` by setting the env the harness reads:

```bash
docker run -d --name graphx-minio -p 9100:9000 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
GRAPHX_TEST_DRIVER=duckdb GRAPHX_TEST_S3_ENDPOINT=http://127.0.0.1:9100 \
  bun test packages/core/test/duck-e2e.test.ts
docker rm -f graphx-minio
```

Add that env branch to the e2e test's `client()` helper: when `GRAPHX_TEST_S3_ENDPOINT` is set, build an `S3ObjectStore` against it with a per-test `prefix`; otherwise use `MemoryObjectStore`. This is the first test that exercises the real CAS path, and it is the one that would catch a provider whose create-if-absent does not enforce.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/graph.ts packages/core/src/serve.ts packages/core/src/duck.ts packages/core/test docs/DUCKDB_SUPPORT.md
git commit -m "feat(core): add the write session, the writer mutex, and error mapping

A commit is object PUTs plus a manifest CAS, so graph.write(fn) groups a
body into one. A bare mutation still commits on its own - the API does
not change - and a nested write joins the enclosing session.

The same mutex that makes batching possible is what makes the conditional
close a compare-and-swap: libSQL reserves the writer with BEGIN IMMEDIATE
and Postgres with SERIALIZABLE, DuckDB has neither, and without
serialization two writers both see rowsAffected = 1 and both insert a
successor, leaving two rows with valid_to = FOREVER.

isRetryableContention learns DuckDB's conflict signals and the lost-commit
race; without them every conflict fell through as a hard 500. 'too much
contention' now maps to 409 rather than 500."
```

---

## Self-review notes

Checked against the spec:

- **§6 storage layout** — Tasks 5 (manifest, keys), 9 (live/history split), 14 (materialize), 15 (commit). The delta/tombstone mechanism is in the manifest type and honored by `materialize`, but no task *produces* deltas: stage 4 rewrites a dirty table whole. Compaction and delta writes are correctly deferred, and `TableRef.files` being a list from day one is what keeps that a pure addition later.
- **§7 commit protocol** — Task 5 (CAS, probe-forward, rebase), Task 4 (provider matrix, probe). `_head` is written best-effort and never trusted.
- **§8 runtime** — Tasks 7 (pool, FATAL rebuild), 8 (all eight landmines), 14 (`NO_VALIDATION`, cache).
- **§9 dialect branch** — Tasks 1, 2, 10, 11.
- **§10.1 ANN** — Task 10. **§10.2 FTS** — not in stages 1–4 by design; Task 13 records it as the largest remaining gap.
- **§11 constraints** — Task 12.
- **§12 outbox/CDC** — partially: `seqHigh` is carried in the manifest (Task 15) and `PG_OUTBOX_VISIBLE` is dropped (Task 2), but the trigger-runner checkpoint change is stage 6.
- **§13 error handling** — Task 16. The startup CAS probe is Task 4; wire its invocation into `DuckClient.open()` when `store` is set.
- **§14 testing** — Tasks 13 and 16.

Two things a reader should know going in. First, Task 12's step 4 depends on how `graph.ts:531-591` learns which rels are single-valued; the task says to read that first and gives both branches. Second, Task 11's test file uses `Graph` API shapes that must be checked against the real `graph.ts` before writing — the assertions are the contract, the call syntax is not.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-28-duckdb-object-storage-s1-4.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
