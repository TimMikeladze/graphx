import { afterEach, expect, test } from 'bun:test';
import { Graph } from '../../src/core/graph.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { init } from '../../src/core/schema.ts';
import { openMemoryDb } from '../../src/core/local.ts';
import { z } from 'zod';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const schema = defineGraphSchema({ nodes: { note: z.object({ name: z.string() }) }, edges: {} });
async function setup() {
  const db = await openMemoryDb(); closes.push(() => db.close()); await init(db);
  const statements: string[] = [];
  const traced = new Proxy(db, { get(target, key) {
    if (key === 'execute') return (input: Parameters<typeof db.execute>[0]) => { statements.push(typeof input === 'string' ? input : input.sql); return db.execute(input); };
    return Reflect.get(target, key);
  } });
  return { db, statements, graph: new Graph(traced, schema) };
}
test('pages complete versions in one query and retains metadata/content pairing', async () => {
  const { graph, statements } = await setup();
  const a = await graph.atomic((scope) => scope.addNode({ type: 'note', data: { name: 'A' }, body: 'orchard' }));
  await graph.atomic((scope) => scope.addNode({ type: 'note', data: { name: 'B' }, body: 'garden' }));
  statements.length = 0;
  const page = await graph.listNodeVersions({ type: 'note', limit: 1 });
  expect(statements).toHaveLength(1);
  expect(page.nodes[0]).toEqual(a);
  expect(page.nextCursor).not.toBeNull();
  const next = await graph.listNodeVersions({ type: 'note', limit: 1, cursor: page.nextCursor! });
  expect(next.nodes[0]?.body).toBe('garden');
  expect(next.nextCursor).toBeNull();
  expect((await graph.listNodeVersions({ type: 'unknown' })).nodes).toEqual([]);
  await expect(graph.listNodeVersions({ limit: 0 })).rejects.toThrow();
});
test('historical bulk reads retain the matching body and revision after a later update', async () => {
  const { graph, db } = await setup();
  const a = await graph.atomic((scope) => scope.addNode({ type: 'note', data: { name: 'A' }, body: 'old' }));
  const at = Number((await db.execute('SELECT valid_from FROM node_versions')).rows[0]?.valid_from);
  await graph.atomic((scope) => scope.updateNode(a.id, { body: 'new', data: { name: 'B' } }, { expectedRevision: a.revision }));
  expect((await graph.listNodeVersions({ asOf: at })).nodes).toEqual([a]);
  expect((await graph.listNodeVersions()).nodes[0]).toMatchObject({ body: 'new', revision: '2', data: { name: 'B' } });
});
test('atomic version pages see their own writes and cannot escape the transaction', async () => {
  const { graph } = await setup();
  let escaped!: () => ReturnType<typeof graph.listNodeVersions>;
  await graph.atomic(async (scope) => {
    await scope.addNode({ type: 'note', data: { name: 'A' }, body: 'atomic' });
    expect((await scope.listNodeVersions()).nodes[0]?.body).toBe('atomic');
    escaped = () => scope.listNodeVersions();
  });
  await expect(escaped()).rejects.toThrow();
});
