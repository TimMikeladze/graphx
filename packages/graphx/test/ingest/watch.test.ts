import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { Graph } from '../../src/core/graph.ts';
import { init } from '../../src/core/schema.ts';
import { makeTestDb, stubEmbedder } from '../core/harness.ts';
import { ingestDir, watchDir } from '../../src/ingest/index.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		note: z.object({ title: z.string().optional() }).passthrough(),
	},
	edges: {
		links_to: { from: 'note', to: 'note' },
	},
});

const embed = stubEmbedder(() => [1, 0, 0, 0], { dim: 4 });

test('watchDir: detects a new file and triggers ingest', async () => {
	const { client, teardown } = makeTestDb({ file: true });
	await init(client, embed);
	const g = new Graph(client, SCHEMA, { embedder: embed });

	const dir = await mkdtemp(join(tmpdir(), 'gx-watch-'));

	// Seed one file and run the initial ingest (caller's responsibility)
	await writeFile(join(dir, 'a.md'), '---\ntype: note\ntitle: A\n---\nalpha');
	await ingestDir({ dir, graph: g });

	let runCount = 0;

	const watcher = watchDir({
		dir,
		graph: g,
		debounceMs: 30,
		onRun: (_result) => {
			runCount++;
		},
	});

	// Poll until the new node appears or ~5 s elapses, REWRITING the trigger file each round.
	// `fs.watch` is not armed synchronously — on a loaded CI runner the registration can land
	// after a single write, and that event is then lost forever. Rewriting keeps producing
	// events until one is observed; ingest is content-hashed, so the repeats are no-ops.
	// Wait for `onRun` too: the node row lands mid-ingest, before the run reports completion.
	const deadline = Date.now() + 5000;
	let found = false;
	while (Date.now() < deadline) {
		await writeFile(join(dir, 'b.md'), '---\ntype: note\ntitle: B\n---\nbeta');
		const rows = await client.execute('SELECT COUNT(*) AS c FROM nodes');
		found = Number(rows.rows[0]!.c) >= 2;
		if (found && runCount >= 1) break;
		await new Promise((r) => setTimeout(r, 50));
	}

	watcher.close();

	expect(found).toBe(true);
	expect(runCount).toBeGreaterThanOrEqual(1);

	await rm(dir, { recursive: true, force: true });
	await teardown();
});

test('watchDir: close() stops further runs', async () => {
	const { client, teardown } = makeTestDb({ file: true });
	await init(client, embed);
	const g = new Graph(client, SCHEMA, { embedder: embed });

	const dir = await mkdtemp(join(tmpdir(), 'gx-watch-close-'));

	await writeFile(join(dir, 'a.md'), '---\ntype: note\ntitle: A\n---\nalpha');
	await ingestDir({ dir, graph: g });

	let runCount = 0;

	const watcher = watchDir({
		dir,
		graph: g,
		debounceMs: 30,
		onRun: () => {
			runCount++;
		},
	});

	// Close immediately — no FS events should trigger ingests
	watcher.close();

	// Write a file after close — should NOT trigger anything
	await writeFile(join(dir, 'b.md'), '---\ntype: note\ntitle: B\n---\nbeta');

	// Wait a bit to confirm no run occurred
	await new Promise((r) => setTimeout(r, 200));

	expect(runCount).toBe(0);

	await rm(dir, { recursive: true, force: true });
	await teardown();
});

test('watchDir: single-flight — rapid writes produce at most two runs (in-flight + trailing)', async () => {
	const { client, teardown } = makeTestDb({ file: true });
	await init(client, embed);
	const g = new Graph(client, SCHEMA, { embedder: embed });

	const dir = await mkdtemp(join(tmpdir(), 'gx-watch-sf-'));

	await writeFile(join(dir, 'seed.md'), '---\ntype: note\ntitle: Seed\n---\nbody');
	await ingestDir({ dir, graph: g });

	const runTimes: number[] = [];

	const watcher = watchDir({
		dir,
		graph: g,
		debounceMs: 30,
		onRun: () => {
			runTimes.push(Date.now());
		},
	});

	// Confirm the watcher is actually armed before measuring a burst: `fs.watch` registers
	// asynchronously, and a burst sent into that window is silently lost — which would leave
	// the run count at 0 and fail the lower bound below for reasons that have nothing to do
	// with single-flight.
	const armedBy = Date.now() + 5000;
	while (Date.now() < armedBy && runTimes.length === 0) {
		await writeFile(join(dir, 'probe.md'), '---\ntype: note\ntitle: Probe\n---\nbody');
		await new Promise((r) => setTimeout(r, 50));
	}
	expect(runTimes.length).toBeGreaterThanOrEqual(1); // watcher is live
	await new Promise((r) => setTimeout(r, 200)); // let the probe's runs drain
	runTimes.length = 0;

	// Fire a burst of FS events by writing multiple files in quick succession.
	// Debounce collapses them into one run; if a run is in progress, at most one
	// trailing run is queued — never more than 2 total for this burst.
	for (let i = 0; i < 5; i++) {
		await writeFile(join(dir, `burst-${i}.md`), `---\ntype: note\ntitle: Burst ${i}\n---\nbody`);
	}
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline && runTimes.length === 0) {
		await new Promise((r) => setTimeout(r, 50));
	}

	// Give a bit more time for any stray trailing runs
	await new Promise((r) => setTimeout(r, 200));

	watcher.close();

	// Debounce + single-flight: at most 2 runs (one in-flight, one trailing)
	expect(runTimes.length).toBeGreaterThanOrEqual(1);
	expect(runTimes.length).toBeLessThanOrEqual(2);

	await rm(dir, { recursive: true, force: true });
	await teardown();
});

test('watchDir: an ingest error is routed to onError; the watcher keeps running', async () => {
	const { client, teardown } = makeTestDb({ file: true });
	await init(client, embed);

	const dir = await mkdtemp(join(tmpdir(), 'gx-watch-err-'));

	let calls = 0;
	const flakyEmbed = stubEmbedder(
		() => {
			calls++;
			throw new Error('embed boom');
		},
		{ dim: 4 },
	);
	const flaky = new Graph(client, SCHEMA, { embedder: flakyEmbed });

	const errors: unknown[] = [];
	const watcher = watchDir({
		dir,
		graph: flaky,
		debounceMs: 30,
		onError: (e) => errors.push(e),
	});

	// New file → watcher run → embed throws → onError (NOT an unhandled rejection / crash).
	// Rewritten each round because `fs.watch` arms asynchronously and can miss a lone write.
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && errors.length === 0) {
		await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\nalpha');
		await new Promise((r) => setTimeout(r, 50));
	}

	watcher.close();
	expect(errors.length).toBeGreaterThanOrEqual(1);
	expect((errors[0] as Error).message).toBe('embed boom');
	expect(calls).toBeGreaterThanOrEqual(1);

	await rm(dir, { recursive: true, force: true });
	await teardown();
});
