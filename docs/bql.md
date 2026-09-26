# bql.sh as a graphx backend

As built. [bql.sh](https://github.com/TimMikeladze/bql) is SQLite as a multi-tenant server for Bun;
this is how graphx reaches it, why it needed no new dialect, and what is deliberately not done yet.

## The one decision everything else follows from

bql.sh is a plain libsqlite3, so graphx talks to it with the **`sqlite` dialect it already had** for
SQLite WASM and Expo — `schema('sqlite')`, `sqliteVectorSeedRows`, the `sqlite` branches in
`hybrid.ts`, `local-blobs.ts` and `algorithms.ts`. The libSQL arm emits `F32_BLOB`,
`libsql_vector_idx`, `vector()` and `vector_top_k`, which exist only in libSQL's fork; an untagged
client reads as `libsql` (`dialectOf`) and `init` would fail on the embeddings DDL.

So `bql` is a **driver, not a dialect**. `DbConfig.driver` widened to a new `Driver` type
(`Dialect | 'bql'`) rather than `Dialect` growing a fifth member: every `switch (dialect)` in the
codebase ends in `assertNever`, so widening the dialect would have been a compile error at dozens of
sites for a backend that needs no new SQL at all.

## What shipped

`packages/graphx/src/core/bql.ts`, published as `graphx/bql`. It imports **no new dependency**:
the embedded driver is typed structurally (`BqlModule` / `BqlDatabase`, the trick `expo.ts` uses
for Expo's SQLite module) and the remote one is `@libsql/client`, which graphx already had.

| Export                                                    | What it is                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `createBqlClient(database)`                             | Takes ownership of an embedded `bql.sh/sqlite` connection    |
| `openBqlDb(module, path)` / `openBqlMemoryDb(module)` | Opens one and verifies WAL, FULL sync and foreign keys          |
| `createBqlRemoteClient(opts)`                           | A client over a bql.sh server's Hrana surface                    |
| `bqlDatabaseName(ns)` / `bqlHranaUrl(origin, db)`     | The namespace → database-name and URL rules                     |
| `bqlDriver`                                             | Registered on import, so `getDb(ns, { driver: 'bql' })` works |

Three small changes outside it: `managedPragmas` on `DbClient` (honoured by `applyConnPragmas`), the
`Driver` split and `registerBqlDriver` in `db.ts`, and one line in `cli-config.ts` so a config
naming `driver: 'bql'` loads the adapter the way `postgres` and `duckdb` do.

### Seam A — embedded

`bql.sh/sqlite`'s `Database` is synchronous with a cached `prepare`, which is exactly graphx's
`SqlConnection`, so the client is `createConnectionClient(…, 'sqlite')` like the WASM and Expo ones.
Three details the adapter gets right and a naive one would not:

- **`safeIntegers` is required.** With it off, bql.sh reads INTEGER columns through the narrow FFI
  symbol and silently rounds past 2^53. `createBqlClient` refuses such a connection.
- **Statements are the host's.** `prepare` returns a cached statement; the adapter never finalizes
  one, and uses `all()` (which resets the cursor) rather than `run()` so a RETURNING clause survives.
- **Transaction control bypasses the cache.** `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` go through
  `exec`, keeping them out of a statement cache sized for the graph's own SQL.

`client.database` is the connection itself, which is the point: commit and preupdate hooks, an
authorizer, session changesets — plus `client.deadline(ms)` and `client.interrupt()`, which no other
graphx driver has.

### Seam B — remote

`createBqlRemoteClient` points `@libsql/client` at `/v1/db/<database>/` (the trailing slash is
load-bearing — `@libsql/core` resolves `v2/pipeline` relatively) and tags the result `sqlite` +
`managedPragmas`. Two things it also owns:

- **`managedPragmas`.** `applyConnPragmas` issues `PRAGMA foreign_keys = ON` and
  `PRAGMA busy_timeout = N`; bql.sh's authorizer answers `SQLITE_DENY` to any pragma in its setting
  form, so those would throw rather than be ignored. The server states both itself.
- **Provisioning.** bql.sh has no create-on-demand, and graphx's contract is that `getDb(ns)` +
  `init(db)` provisions a namespace (the Postgres adapter creates the tenant's schema; DuckDB creates
  the file). So the driver does `POST /v1/db` on first use, tolerating a 409, then
  `PATCH /v1/db/{db} {foreignKeys: true}` — bql.sh defaults `[sqlite] foreignKeys` **off** and graphx's
  schema declares foreign keys. Both are admin routes, so the token must be an admin key;
  `ensureDatabase: false` opts out.

**Names are case-folded.** bql.sh names match `[a-z0-9][a-z0-9_-]{0,63}` and a graphx namespace need
not — `evt_01M3E2K3W0…` pairs a lower-case prefix with a ULID. Folding is safe rather than merely
convenient: bql.sh keeps a directory per database, so on a case-insensitive filesystem two names
differing only in case were never two databases anyway.

## Verified

- **The whole core suite against a live bql.sh server**: `764 pass, 27 skip, 0 fail` over Hrana,
  including FTS5 retrieval, bitemporal reads, interactive transactions, constraints, the outbox and
  the served HTTP API. Run it with a server up:

  ```sh
  cd ../bql && bun run db sqlite:build && BQL_SERVER_PORT=4399 bun run db start
  GRAPHX_TEST_DRIVER=bql GRAPHX_BQL_URL=http://127.0.0.1:4399 \
    GRAPHX_BQL_TOKEN=<admin key> bun test packages/graphx/test/core
  ```

  The harness creates one bql.sh database per test and deletes it on teardown; `localConnectionOnly`
  gates the handful of probes that set a pragma, which is not a tenant's to do here.

- **The embedded driver against the real `bql.sh`**: pattern matching, hybrid retrieval, an
  enforced foreign key, WAL on a file and MEMORY in RAM, and a commit hook firing on a graphx
  mutation's own commit — both in memory and on a file.
- `test/core/bql.test.ts` covers the adapter contract without a server (a `bun:sqlite` stand-in in
  bql.sh's shape), the name and URL rules, the `managedPragmas` behaviour, `getDb` and the CLI config.
- The ranking golden now carries a `bql` section, recorded the documented way
  (`UPDATE_RANKING_GOLDEN=1 GRAPHX_TEST_DRIVER=bql`); the other three dialects' sections are
  untouched.

## Not done

- **No CI leg.** `bql.sh` is not published, so a GitHub runner cannot install it. The conformance
  run above is manual until bql.sh ships to npm; then it is a job like the `postgres` and `duckdb`
  ones, with `sqlite:build` as a step.
- **No ANN.** `sqliteVectorSeedRows` reads every embedding row and ranks in JS: a table scan when
  embedded, and every vector in the namespace crossing the socket when remote, where it meets
  bql.sh's `maxRows` cap first. The fix is `sqlite-vec` in bql.sh's pinned build plus a vector arm in
  `dialect-sql.ts`, and it should be driven by a measurement rather than by taste. Until then this
  backend is for lexical-first graphs and small vector sets.
- **Push CDC is not wired.** The hook is reachable (`client.database.onCommit`) and verified to fire,
  but nothing in graphx installs it: `triggers.ts` and `graphx/react` still poll `outboxTail` and
  `changeFeed`. A `GraphEventSink` fed by a commit hook (embedded) and by bql.sh's live queries
  (remote) is the step that makes this pairing more than parity.
- **`bql.sh/bus` is untouched.** `triggers.ts` hand-rolls retries, a cursor and dead letters that the
  bus already has; worth revisiting once the CDC step lands.
