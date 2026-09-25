# AGENTS.md — using graphx

Use graphx to store, query and serve a temporal graph from TypeScript. Import from the `graphx` package and its subpaths.

## Install

```sh
bun add graphx
```

## Minimal working snippet

```ts
import { defineConfig, defineGraphSchema, hashEmbed } from 'graphx';
import { z } from 'zod';

export const schema = defineGraphSchema({
	nodes: {
		site: z.object({ name: z.string(), region: z.enum(['us', 'eu']) }),
		gateway: z.object({ name: z.string(), firmware: z.string() }),
		alert: z.object({ severity: z.enum(['low', 'high']) }),
	},
	edges: {
		deployedAt: { from: 'gateway', to: 'site', single: true },
		raised: { from: 'gateway', to: 'alert' },
	},
});

export default defineConfig({ schema, embedder: hashEmbed(), namespace: 'graphx' });
```

```ts
import { getDb, init, Graph, hashEmbed } from 'graphx';
import { schema } from './graphx.config.ts';

const embedder = hashEmbed();
const db = getDb('acme__alpha'); // one cached client per namespace (tenant)
await init(db, embedder); // tables, indexes, and the vector table at the embedder's width
const g = new Graph(db, schema, { embedder });

const site = await g.addNode({ type: 'site', data: { name: 'us-east-1', region: 'us' } });
const gw = await g.addNode({
	type: 'gateway',
	data: { name: 'gw-1', firmware: '2.1.0' },
	body: 'free text — indexed for FTS and embedded for vector search by the graph itself',
});
await g.addEdge({ rel: 'deployedAt', src: gw.id, dst: site.id });
```

## Options that matter

| Option | Where | Effect |
| --- | --- | --- |
| `asOf` | epoch ms on any read | Point-in-time view |
| `single: true` | edge definition | Single-valued rel; each addEdge closes the previous live one |
| `expectedRevision` | update option | Concurrent writer surfaces as RevisionConflict |
| `embedding: 'lazy' \| 'off'` | Graph option | Defer embedding to an embedTrigger, or never embed |
| `limits` | read option | Row cap, fan-out guard and timeout |
| `driver` | getDb config \| 'postgres' or 'duckdb'; default is libSQL |

## Three mistakes that break it

1. Importing `getDb` with `driver: 'postgres'` or `'duckdb'` without `import 'graphx/pg'` / `import 'graphx/duck'` first. The adapter is a side effect, and `getDb` throws without it.
2. Switching the embedder model without running `graphx reembed`. The namespace records the model and width and refuses a different one.
3. Calling `journey` without `from` (epoch ms). It is required, and only edges valid at each step are followed.

## More

- [Reference](https://graphx.sh/reference)
- [llms.txt](https://graphx.sh/llms.txt)
- [Repository](https://github.com/TimMikeladze/graphx)
