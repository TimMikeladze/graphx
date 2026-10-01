# Fork

Branch one namespace into another: the same nodes, edges, history and vectors, optionally as the
graph stood at an instant, after which the two diverge. It is the "what if" primitive, and a
backend migration when the target is a different backend.

```ts
const whatIf = await g.fork(getDb('acme__what-if')); // a Graph over the branch
const replay = await g.fork(getDb('acme__replay'), { asOf: lastWeek });
const { method, nodes, needsEmbedding } = await fork(db, target, { asOf, method: 'auto' });
```

`graphx fork <namespace> [--as-of <ms|ISO>]` does the same from the CLI.

## Two ways to make the branch

| Method   | When                                                                                  | Cost                                                                                         |
| -------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `copy`   | Always available; any backend to any backend                                          | Linear in the history copied                                                                 |
| `native` | Source and target are databases on the **same bql.sh server**, target not yet created | bql.sh forks the database file (a reflink where the filesystem has one), then trims in place |

`method: 'auto'` (the default) tries `native` and falls back to `copy` whenever native does not
apply: a different backend, a different server, a target that already exists, or a token that
cannot create databases. `method: 'copy'` forces the copy. `ForkResult.method` reports which ran.

### Copy (`fork.ts`)

Plain per-dialect SQL, paged by `ver` (500 rows per round trip): `graph_meta` facts and the
embedding table first, then node versions, edge versions (endpoint identities ensured), vectors,
referenced local blobs, analytics on a full fork only, and constraints last so each index is built
once over the loaded rows. If any step fails, what the copy wrote is deleted again — rows, the
`graph_meta` facts it set, its blobs, and the vector table if it created it — so the target is the
empty namespace it was and the fork can be retried.

### Native (bql.sh)

A client from `createBqlRemoteClient` (and so `getDb(ns, { driver: 'bql' })`) carries a
`nativeFork(target)` capability. It applies when the target is another bql.sh client on the same
origin whose database does not exist yet (two clients on the _same_ database are refused with a
`ForkError`):

1. `POST /v1/db { name: target, from: { db: source } }` — bql.sh forks the whole database at its
   current txid and records the lineage (`parent`, `forkedAt`).
2. The branch inherits the source's foreign-key setting (bql.sh ≥ 0.4.0). The target client's
   setting decides, as for a database `ensureDatabase` creates: when it wants foreign keys and the
   branch did not inherit them, `PATCH /v1/db/{target} { foreignKeys: true }`. Otherwise nothing is
   sent, since the PATCH closes and reopens the database.
3. graphx then makes the result match what `copy` would have produced (below).

If step 2 or 3 fails, the branch is deleted (`DELETE /v1/db/{target}`) and the error rethrown: an
untrimmed branch holds the source's whole present instead of the cut, so it is never left behind.
The target client forgets that its database was provisioned, so it can be used again.

bql.sh's own point-in-time fork (`from.at`) is **not** used for `asOf`. It cuts by the database's
commit time, and graphx's `asOf` cuts by valid time: history loaded with `bulkLoad` or an import
carries `valid_from` values from long before the database existed, and a commit-time cut would get
those wrong or be refused by a log that does not reach back that far. A full native fork followed by
an in-place trim is exact for both.

## What a branch holds — the same for both methods

- **Full fork:** every node and edge version verbatim, vectors, blobs, constraints, analytics.
- **`asOf` fork:** versions that began after the cut are left behind; a version open at the cut is
  reopened (live in the branch); history before the cut is intact, so `asOf` reads in the branch
  still answer. Analytics are dropped (they describe the graph now). Vectors are kept only for nodes
  whose cut-time version is still the source's live one; the rest are listed in `needsEmbedding`
  and `Graph.fork` re-embeds them when it has an embedder.
- **Never:** the outbox, trigger cursors, dead letters and archival state. A branch starts a fresh
  event log.

Native trim, in one write batch on the target: clear the event tables; on a cut, drop analytics,
drop vectors not valid at the cut, delete versions with `valid_from > cut`, reopen versions with
`valid_to > cut`, delete identities nothing references, and rebuild the external-content FTS index;
always, delete local blobs no kept version references.

The one difference that remains: a native fork keeps the source's `ver` numbers; a copy re-mints
them.

## Consistency

A native fork is one consistent snapshot even while the source takes writes. A copy with `asOf` is
consistent too; a full copy of a namespace under concurrent writes can observe a write half-copied,
so pass `asOf: Date.now()` for a clean cut of a live namespace.

## Tests

`test/core/fork.test.ts` runs on every `GRAPHX_TEST_DRIVER` — under `bql` its forks are between
two databases on one server, so they take the native path. `test/core/fork-bql.test.ts` starts an
embedded bql.sh server and checks that native and copy report the same branch (full and `asOf`,
with vectors), that the event log does not travel, that a fork falls back to copy when the target
exists or is another backend, and that a failed trim deletes the branch. It skips when `bql.sh` or
its libsqlite3 is not installed; CI builds the library, so it runs there.
