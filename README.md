# graphx

Elegant and performant component library

## Installation

```bash
bun add core
```

## Usage

```typescript
import { greet } from 'core';

console.log(greet('World')); // Hello, World!
```

## Database backend

graphx runs on **libSQL/SQLite** (default) or **Postgres** (with [pgvector](https://github.com/pgvector/pgvector)). The backend is selected by configuration only — every public type, method, HTTP route, and JSON contract is identical across both.

Connections come from `getDb(namespace, config)`, which caches one client per project namespace (tenant).

### libSQL (default)

```ts
import { getDb } from 'core';

const db = getDb('acme__alpha'); // file:acme__alpha.db
```

No `driver` is needed. For embedded-replica mode, set `SQLD_URL` / `SQLD_TOKEN` (or `config.syncUrl` / `config.authToken`).

### Postgres

Import the `core/pg` subpath once to register the Postgres adapter with `getDb`. This is a side effect, and it keeps `pg` an optional peer dependency — loaded only by consumers who opt in:

```ts
import 'core/pg'; // registers the Postgres driver (side effect)
import { getDb } from 'core';

const db = getDb('acme__alpha', {
  driver: 'postgres',
  connectionString: 'postgresql://user:pass@host:5432/graphx',
  // ssl?: boolean | tls.ConnectionOptions
  // poolMax?: number
});
```

Alternatively, select Postgres globally with `GRAPHX_DB_DRIVER=postgres` (and `GRAPHX_PG_URL` for the connection string). You must still `import 'core/pg'` once, or `getDb` throws.

**Tenant model.** Each namespace maps to a Postgres **schema** on a shared connection pool, created lazily — one server credential serves every tenant. (libSQL uses one file/replica per namespace instead.)

**Prerequisite.** The `vector` extension (pgvector) must exist in the target database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

This is a one-time, idempotent setup per database and needs a role allowed to create the extension (e.g. a superuser). The `pgvector/pgvector:pg16` Docker image ships pgvector ready to enable.

See [docs/POSTGRES_SUPPORT.md](./docs/POSTGRES_SUPPORT.md) for the full dual-backend design and per-dialect details.

## Contributing

Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT
