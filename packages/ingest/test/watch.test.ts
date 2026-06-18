import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../core/src/define-graph-schema.ts';
import { Graph } from '../../core/src/graph.ts';
import type { EmbedFn } from '../../core/src/retrieve.ts';
import { init } from '../../core/src/schema.ts';
import { makeTestDb } from '../../core/test/harness.ts';
import { ingestDir, watchDir } from '../src/index.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		note: z.object({ title: z.string().optional() }).passthrough(),
	},
	edges: {
		links_to: { from: 'note', to: 'note' },
	},
});

const embed: EmbedFn = async () => [1, 0, 0, 0];

test('watchDir: detects a new file and triggers ingest', async () => {
	const { client, teardown } = makeTestDb({ file: true });
	await init(client, 4);
	const g = new Graph(client, SCHEMA);

	const dir = await mkdtemp(join(tmpdir(), 'gx-watch-'));

	// Seed one file and run the initial ingest (caller's responsibility)
	await writeFile(join(dir, 'a.md'), '---\nkind: note\ntitle: A\n---\nalpha');
	await ingestDir({ dir, graph: g, embed });

	let runCount = 0;

	const watcher = watchDir({
		dir,
		graph: g,
		embed,
		debounceMs: 30,
		onRun: (_result) => {
			runCount++;
		},
	});

	// Write a new file — should trigger a watcher ingest
	await writeFile(join(dir, 'b.md'), '---\nkind: note\ntitle: B\n---\nbeta');

	// Poll until the new node appears or ~3 s elapses
	const deadline = Date.now() + 3000;
	let found = false;
	while (Date.now() < deadline) {
		const rows = await client.execute('SELECT COUNT(*) AS c FROM nodes');
		if (Number(rows.rows[0]!.c) >= 2) {
			found = true;
			break;
		}
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
	await init(client, 4);
	const g = new Graph(client, SCHEMA);

	const dir = await mkdtemp(join(tmpdir(), 'gx-watch-close-'));

	await writeFile(join(dir, 'a.md'), '---\nkind: note\ntitle: A\n---\nalpha');
	await ingestDir({ dir, graph: g, embed });

	let runCount = 0;

	const watcher = watchDir({
		dir,
		graph: g,
		embed,
		debounceMs: 30,
		onRun: () => {
			runCount++;
		},
	});

	// Close immediately — no FS events should trigger ingests
	watcher.close();

	// Write a file after close — should NOT trigger anything
	await writeFile(join(dir, 'b.md'), '---\nkind: note\ntitle: B\n---\nbeta');

	// Wait a bit to confirm no run occurred
	await new Promise((r) => setTimeout(r, 200));

	expect(runCount).toBe(0);

	await rm(dir, { recursive: true, force: true });
	await teardown();
});

test('watchDir: single-flight — rapid writes produce at most two runs (in-flight + trailing)', async () => {
	const { client, teardown } = makeTestDb({ file: true });
	await init(client, 4);
	const g = new Graph(client, SCHEMA);

	const dir = await mkdtemp(join(tmpdir(), 'gx-watch-sf-'));

	await writeFile(join(dir, 'seed.md'), '---\nkind: note\ntitle: Seed\n---\nbody');
	await ingestDir({ dir, graph: g, embed });

	const runTimes: number[] = [];

	const watcher = watchDir({
		dir,
		graph: g,
		embed,
		debounceMs: 30,
		onRun: () => {
			runTimes.push(Date.now());
		},
	});

	// Fire a burst of FS events by writing multiple files in quick succession.
	// Debounce collapses them into one run; if a run is in progress, at most one
	// trailing run is queued — never more than 2 total for this burst.
	const deadline = Date.now() + 3000;
	let burstSent = false;
	while (Date.now() < deadline) {
		if (!burstSent) {
			for (let i = 0; i < 5; i++) {
				await writeFile(join(dir, `burst-${i}.md`), `---\nkind: note\ntitle: Burst ${i}\n---\nbody`);
			}
			burstSent = true;
		}
		if (runTimes.length >= 1) break;
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
	await init(client, 4);
	const g = new Graph(client, SCHEMA);

	const dir = await mkdtemp(join(tmpdir(), 'gx-watch-err-'));

	let calls = 0;
	const flakyEmbed: EmbedFn = async () => {
		calls++;
		throw new Error('embed boom');
	};

	const errors: unknown[] = [];
	const watcher = watchDir({
		dir,
		graph: g,
		embed: flakyEmbed,
		debounceMs: 30,
		onError: (e) => errors.push(e),
	});

	// New file → watcher run → embed throws → onError (NOT an unhandled rejection / crash)
	await writeFile(join(dir, 'a.md'), '---\nkind: note\n---\nalpha');
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline && errors.length === 0) {
		await new Promise((r) => setTimeout(r, 50));
	}

	watcher.close();
	expect(errors.length).toBeGreaterThanOrEqual(1);
	expect((errors[0] as Error).message).toBe('embed boom');
	expect(calls).toBeGreaterThanOrEqual(1);

	await rm(dir, { recursive: true, force: true });
	await teardown();
});
