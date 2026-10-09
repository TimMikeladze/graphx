/**
 * Example — a correction, read along both time axes. A yield recorded for 1992 turns out to be
 * wrong; the fix replaces what the graph says about the past, and every read can still ask what
 * the graph believed before the fix.
 *
 * Run: `bun run examples/correction-demo.ts` (writes `correction_demo.db` in the working
 * directory and starts it fresh on every run).
 */
import { rmSync } from 'node:fs';
import { closeAll, defineGraphSchema, getDb, Graph, history, init } from 'graphx';
import { z } from 'zod';

const schema = defineGraphSchema({
	nodes: { field: z.object({ name: z.string(), yield: z.number() }) },
	edges: {},
});

for (const suffix of ['', '-wal', '-shm']) rmSync(`correction_demo.db${suffix}`, { force: true });
const db = getDb('correction_demo');
await init(db);
const g = new Graph(db, schema);

const y = (year: number) => Date.UTC(year, 0, 1);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const tick = () => new Promise((r) => setTimeout(r, 5));

// An import states a fact about the past: the field has yielded 0.90 since 1992.
const field = await g.addNode({
	type: 'field',
	data: { name: 'North', yield: 0.9 },
	validFrom: y(1992),
});
await tick();
const beforeFix = Date.now();
await tick();

// Later we learn the 1992 survey was miscalibrated: it was 0.88 all along.
await g.correctNode(field.id, { data: { yield: 0.88 } }, { validFrom: y(1992) });

const yieldIn = async (slice: { asOf?: number; recordedAsOf?: number }) =>
	(await g.getNode(field.id, slice))?.data.yield;
console.log('in 1995, as we know it now     ', await yieldIn({ asOf: y(1995) }));
console.log(
	'in 1995, as we knew it then    ',
	await yieldIn({ asOf: y(1995), recordedAsOf: beforeFix }),
);
console.log('today                          ', await yieldIn({}));

// Nothing was overwritten: the old belief is still stored, just no longer current.
for (const v of await history(db, field.id)) {
	const data = JSON.parse(String(v.data)) as { yield: number };
	console.log(
		`history  yield=${data.yield}  valid ${day(Number(v.valid_from))} → open  ${v.current ? 'current' : 'superseded'}`,
	);
}

closeAll();
