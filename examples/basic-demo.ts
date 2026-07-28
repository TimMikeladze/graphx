/**
 * Example — graphx end to end in one file: schema → init → write → read → query → retrieve →
 * time travel. Every step prints what it got back, so the output doubles as a tour of the API.
 *
 * Run: `bun run examples/basic-demo.ts` (writes `basic_demo.db` in the working directory;
 * `bun run clean:db` sweeps it up).
 */
import {
	closeAll,
	defineGraphSchema,
	diff,
	getDb,
	Graph,
	hashEmbed,
	history,
	hybridRetrieve,
	init,
	journey,
	match,
	pagerank,
	retrieve,
	shortestPath,
} from '@graphx/core';
import { z } from 'zod';

// 1 — schema: node types are Zod objects, edges name their endpoints
const schema = defineGraphSchema({
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

// 2 — connection + init. dim is baked into the vector column on first init.
const embed = hashEmbed(768);
const db = getDb('basic_demo');
await init(db, 768);
const g = new Graph(db, schema);

// 3 — writes. `data` is the typed payload; `body` is FTS-indexed text; `emb` is the ANN vector.
const site = await g.addNode({ type: 'site', data: { name: 'us-east-1', region: 'us' } });
const gwBody = 'edge gateway in us-east-1, sensor reported overheating last night';
const gw = await g.addNode({
	type: 'gateway',
	data: { name: 'gw-1', firmware: '2.1.0' },
	body: gwBody,
	emb: await embed(gwBody), // Graph does NOT embed for you — pass the vector or ANN sees NULL
});
const alertBody = 'temperature threshold exceeded on gw-1';
const alert = await g.addNode({
	type: 'alert',
	data: { severity: 'high' },
	body: alertBody,
	emb: await embed(alertBody),
});
await g.addEdge({ rel: 'deployedAt', src: gw.id, dst: site.id });
await g.addEdge({ rel: 'raised', src: gw.id, dst: alert.id });

const t0 = Date.now();
await new Promise((r) => setTimeout(r, 5));

// 4 — update: shallow merge, opens a new version (nothing overwritten)
await g.updateNode(gw.id, { data: { firmware: '2.2.0' } });

// 5 — reads
console.log('getNode   ', await g.getNode(gw.id));
console.log('neighbors ', (await g.neighbors(gw.id, { rels: ['deployedAt'] })).map((n) => n.data));
console.log('listNodes ', (await g.listNodes({ type: 'alert' })).nodes.length, 'alerts');

// 6 — pattern match, typed per alias
const q = await match(schema, db) // NOTE: .select() is async — await it, then .run()
	.node('gw', 'gateway')
	.out('raised')
	.node('a', 'alert')
	.select('gw', 'a');
const rows = await q.run();
console.log('match     ', rows.map((r) => [r.gw.data.name, r.a.data.severity]));

// 7 — retrieval: ANN seeds + time-respecting walk / hybrid vector+FTS with RRF
console.log('retrieve  ', await retrieve(db, embed, { query: 'overheating', k: 5, maxDepth: 2 }));
console.log('hybrid    ', await hybridRetrieve(db, embed, { query: 'overheating gw-1', k: 5 }));

// 8 — traversal + algorithms
console.log('journey   ', await journey(db, { start: gw.id, from: 0, maxDepth: 3, direction: 'forward' }));
console.log('path      ', await shortestPath(db, gw.id, alert.id));
console.log('pagerank  ', [...(await pagerank(db))]);

// 9 — time travel: every version, and what changed between two instants
console.log('history   ', (await history(db, gw.id)).length, 'versions');
const past = await g.listNodes({ type: 'gateway', asOf: t0 });
console.log('asOf t0   ', past.nodes.map((n) => n.data)); // firmware as it stood before the update
console.log('diff      ', await diff(db, t0, Date.now()));

closeAll();
