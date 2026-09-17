// Browser-only conformance harness. Domain operations stay inside the worker.
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { openBrowserDb } from '../../../src/core/browser.ts';
import { Graph, defineGraphSchema, init, history } from '../../../src/core/portable.ts';
import { createLocalBlobStore } from '../../../src/core/local-blobs.ts';
import { z } from 'zod';

const sqlite = await sqliteInit({ locateFile: (name: string) => `/sqlite/${name}` });
const schema = defineGraphSchema({
	nodes: { note: z.object({ name: z.string() }) },
	edges: { links: { from: 'note', to: 'note' } },
});
let client: Awaited<ReturnType<typeof openBrowserDb>>;
let graph: Graph<typeof schema>;
self.onmessage = async ({ data: { id, op, args } }) => {
	try {
		let value: unknown;
		if (op === 'open') {
			client = await openBrowserDb(sqlite, args.filename);
			await init(client);
			graph = new Graph(client, schema);
			value = {
				journal: (await client.execute('PRAGMA journal_mode')).rows,
				version: sqlite.version.libVersion,
			};
		} else if (op === 'seed') {
			const created = await graph.atomic(async (scope) => {
				const blob = await scope.blobs.put(new Uint8Array([0, 255, 1, 128]));
				const note = await scope.addNode({
					type: 'note',
					data: { name: 'orchard' },
					body: 'peach orchard',
				});
				const other = await scope.addNode({
					type: 'note',
					data: { name: 'harvest' },
					body: 'summer harvest',
					uri: blob.uri,
					content_hash: blob.hash,
				});
				await scope.addEdge({ rel: 'links', src: note.id, dst: other.id });
				return { note, other, blob };
			});
			await graph.atomic((scope) =>
				scope.updateNode(
					created.note.id,
					{ body: 'peach orchard edited' },
					{ expectedRevision: created.note.revision },
				),
			);
			value = { id: created.note.id, other: created.other.id, blob: created.blob.uri };
		} else if (op === 'read') {
			const blobs = await createLocalBlobStore(client);
			value = {
				body: (await graph.getNodeContent(args.id))?.body,
				history: (await history(client, args.id)).length,
				found: (await graph.listNodes({ q: 'orchard' })).nodes.map((n) => n.id),
				neighbors: (await graph.neighbors(args.id)).map((n) => n.id),
				bytes: Array.from((await blobs.get(args.blob)) ?? []),
			};
		} else if (op === 'write') {
			value = await graph.atomic((scope) =>
				scope.addNode({ type: 'note', data: { name: args.name }, body: args.name }),
			);
		} else if (op === 'count') {
			value = (await graph.listNodes()).nodes.length;
		} else if (op === 'hold') {
			const tx = await client.transaction();
			await tx.execute("INSERT INTO graph_meta(key,value) VALUES ('crash_probe','uncommitted')");
			value = 'transaction-held';
		} else if (op === 'recovered') {
			value = (await client.execute("SELECT value FROM graph_meta WHERE key='crash_probe'")).rows;
		} else if (op === 'close') {
			await client.close();
			value = 'closed';
		} else throw new Error(`Unknown test operation: ${op}`);
		self.postMessage({ id, value });
	} catch (error) {
		self.postMessage({ id, error: String(error) });
	}
};
self.postMessage({ ready: true });
