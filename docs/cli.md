# graphx/cli

The `graphx` binary — scaffold a project, ingest a vault, serve the graph over HTTP, and run
declarative triggers. A thin driver over [`graphx`](../packages/graphx) and
[`graphx/ingest`](./ingest.md); everything it does is reachable from the SDK too.

## Install

```sh
bunx graphx new my-app     # no install needed to scaffold
```

or as a dev dependency of a project:

```sh
bun add -d graphx/cli
```

The shebang is `#!/usr/bin/env bun` — the binary runs under Bun, and it imports your
`graphx.config.ts` directly, which is the reason it does not run under plain Node.

## Commands

```
graphx new      <dir>                     Scaffold a starter project
graphx serve    [-c config] [-p 8899]     Typed HTTP routes + /openapi.json + /docs
graphx ingest   <dir> [options]           Ingest a vault into the graph
graphx triggers [-c config]               Run declarative triggers over the event outbox
graphx mcp      [-c config] [--read-only] Serve the graph to an MCP client over stdio (see docs/mcp.md)
graphx reembed  [-c config] [--dry-run]   Re-embed every live node with the configured embedder
graphx doctor   [-c config]               Report the namespace's embedding model, width, and health
```

`--help` prints the full option list.

`reembed` is also how a namespace changes models: when the config's embedder differs from the one the
namespace was initialised with, it drops the stored vectors, recreates the vector table at the new
width, and re-embeds every live node. `--dry-run` prints the report and the count without writing.

`doctor` prints the recorded model and width, the configured embedder, and how many live nodes are
embedded, unembedded (their policy yields text but no vector exists), or stale (the vector was
computed from different text or a different model) — and says when `reembed` is needed.

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
schema mismatch rejecting every file) is visible rather than hidden behind a count. An embedder
that disagrees with the namespace fails the whole run up front rather than embedding every node
into the wrong space.

## `graphx.config.ts`

Every command except `new` loads this file. It is the whole contract:

```ts
import { defineConfig, defineGraphSchema, hashEmbed } from 'graphx';
import { z } from 'zod';

export const schema = defineGraphSchema({
	nodes: { note: z.object({ title: z.string().optional() }) },
	edges: { links_to: { from: 'note', to: 'note' } },
});

export default defineConfig({
	schema,
	embedder: hashEmbed(), // deterministic and model-free — swap in a real model for production
	namespace: 'graphx',
	// embedding?: 'sync' | 'lazy' — embed inside each write (default) or via `embedTrigger`
	// db?: DbConfig            — backend selection; `{ driver: 'postgres' | 'duckdb', ... }`
	// triggers?: Trigger[]     — rules for `graphx triggers`
	// triggerRunner?: {...}    — runner tuning; `name` keys the cursor row (default 'graphx')
});
```

`embedder` is any `Embedder` — `hashEmbed()` for development, `openai(...)` / `voyage(...)` /
`ollama(...)` from `graphx/embedders`, or your own via `defineEmbedder({ id, embed })`. There is no
`dim`: the width is probed from the model and recorded in the namespace with the model's id, and a
different embedder later is refused until `graphx reembed` switches the namespace over. Omit
`embedder` to run without vectors (full-text and graph reads still work). A config that still sets
`embed` or `dim` is refused with a message naming the replacement.

Setting `db.driver` is enough: the CLI imports `graphx/pg` or `graphx/duck` for you when it sees
that driver, so the optional peers stay off the path for everyone else.

Trigger _actions are functions_, which is why they live in this config module rather than in a
database row — and why `graphx triggers` is a process you host rather than something the server
runs on your behalf.

## License

MIT
