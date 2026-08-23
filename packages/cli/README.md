# graphx-cli

The `graphx` binary — scaffold a project, ingest a vault, serve the graph over HTTP, and run
declarative triggers. A thin driver over [`graphx-core`](../core) and
[`graphx-ingest`](../ingest); everything it does is reachable from the SDK too.

## Install

```sh
bunx graphx-cli new my-app     # no install needed to scaffold
```

or as a dev dependency of a project:

```sh
bun add -d graphx-cli
```

The shebang is `#!/usr/bin/env bun` — the binary runs under Bun, and it imports your
`graphx.config.ts` directly, which is the reason it does not run under plain Node.

## Commands

```
graphx new      <dir>                     Scaffold a starter project
graphx serve    [-c config] [-p 8899]     Typed HTTP routes + /openapi.json + /docs
graphx ingest   <dir> [options]           Ingest a vault into the graph
graphx triggers [-c config]               Run declarative triggers over the event outbox
```

`--help` prints the full option list.

| `ingest` option            | Meaning                                                 |
| -------------------------- | ------------------------------------------------------- |
| `--config, -c <path>`      | Config file (default `./graphx.config.ts`)              |
| `--source <id>`            | Logical source id (default `default`)                   |
| `--id-field <name>`        | Frontmatter key carrying stable identity (default `id`) |
| `--prune`                  | Retract nodes for files that vanished                   |
| `--watch, -w`              | Keep watching the directory after the initial pass      |
| `--assets-type <type>`     | Create asset nodes of this type                         |
| `--edge-field <field=rel>` | Map a frontmatter field to an edge rel (repeatable)     |
| `--dangling-type <type>`   | Create stub nodes for links to notes that don't exist   |
| `--tags-type <type>`       | Create shared tag nodes of this type                    |

`ingest` prints a one-line summary (`added= updated= unchanged= deleted= edgesAdded= edgesClosed=
skipped=`), and when anything was skipped, a breakdown by reason code — a systemic failure (a
schema or dimension mismatch rejecting every file) is visible rather than hidden behind a count.

## `graphx.config.ts`

Every command except `new` loads this file. It is the whole contract:

```ts
import { defineGraphSchema, hashEmbed } from 'graphx-core';
import { z } from 'zod';

export const schema = defineGraphSchema({
	nodes: { note: z.object({ title: z.string().optional() }) },
	edges: { links_to: { from: 'note', to: 'note' } },
});

export default {
	schema,
	embed: hashEmbed(768), // deterministic and model-free — swap in a real model for production
	dim: 768,
	namespace: 'graphx',
	// db?: DbConfig            — backend selection; `{ driver: 'postgres', connectionString }`
	// triggers?: Trigger[]     — rules for `graphx triggers`
	// triggerRunner?: {...}    — runner tuning; `name` keys the cursor row (default 'graphx')
};
```

`dim` must be set explicitly and must match your embedder's output width. It is baked into the
vector column the first time the schema is created and cannot be changed afterwards — a wrong
value rejects every subsequent insert.

Setting `db.driver: 'postgres'` is enough: the CLI imports `graphx-core/pg` for you when it sees
that driver, so the optional `pg` peer stays off the path for everyone else.

Trigger _actions are functions_, which is why they live in this config module rather than in a
database row — and why `graphx triggers` is a process you host rather than something the server
runs on your behalf.

## License

MIT
