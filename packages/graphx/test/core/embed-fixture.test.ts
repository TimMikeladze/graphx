import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { fixtureEmbed } from '../../src/core/embed-fixture.ts';
import type { EmbedFn } from '../../src/core/retrieve.ts';

// Record/replay embedder. The contract that matters: after ONE recording run, every later run
// is offline and deterministic, and a miss is loud instead of silently hitting the network.

const dir = mkdtempSync(join(tmpdir(), 'graphx-emb-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function tmpPath(): string {
	return join(dir, `fx-${seq++}.json`);
}

/** A counting stand-in for the real (paid, networked) embedder. */
function spyEmbed(dim = 4): EmbedFn & { calls: number } {
	const fn = async (text: string): Promise<number[]> => {
		fn.calls++;
		return Array.from({ length: dim }, (_, i) => (text.charCodeAt(i % text.length) % 10) / 10);
	};
	fn.calls = 0;
	return fn;
}

test('fixtureEmbed: records on refresh, then replays with ZERO real embedder calls', async () => {
	const path = tmpPath();
	const real = spyEmbed();

	const recorder = fixtureEmbed({ path, embed: real, refresh: true });
	const recorded = await recorder('bletchley park');
	expect(recorder.stats.recorded).toBe(1);
	expect(recorder.save()).toBe(true);

	// A second process would construct a fresh embedder over the same file — with NO real
	// embedder at all, proving replay never reaches for the network.
	const replay = fixtureEmbed({ path, refresh: false });
	expect(await replay('bletchley park')).toEqual(recorded);
	expect(replay.stats.hits).toBe(1);
	expect(real.calls).toBe(1); // still 1 — the replay added nothing
});

test('fixtureEmbed: a miss in replay mode throws naming the text, instead of calling the model', async () => {
	const path = tmpPath();
	const real = spyEmbed();
	const recorder = fixtureEmbed({ path, embed: real, refresh: true });
	await recorder('known text');
	recorder.save();

	const replay = fixtureEmbed({ path, embed: real, refresh: false });
	await expect(replay('never recorded')).rejects.toThrow(/no cached vector for "never recorded"/);
	await expect(replay('never recorded')).rejects.toThrow(/UPDATE_EMBED_FIXTURES=1/);
	expect(real.calls).toBe(1); // the recording call only — the miss did NOT fall back to it
});

test('fixtureEmbed: replay-only (no `embed`) still serves hits', async () => {
	const path = tmpPath();
	const recorder = fixtureEmbed({ path, embed: spyEmbed(), refresh: true });
	const v = await recorder('cached');
	recorder.save();

	const replay = fixtureEmbed({ path });
	expect(await replay('cached')).toEqual(v);
});

test('fixtureEmbed: recording without a real embedder throws (nothing to record from)', async () => {
	const replay = fixtureEmbed({ path: tmpPath(), refresh: true });
	await expect(replay('x')).rejects.toThrow(/needs a real embedder/);
});

test('fixtureEmbed: a dim change mid-fixture throws instead of poisoning the file', async () => {
	const path = tmpPath();
	const four = fixtureEmbed({ path, embed: spyEmbed(4), refresh: true });
	await four('first');
	four.save();

	const eight = fixtureEmbed({ path, embed: spyEmbed(8), refresh: true });
	await expect(eight('second')).rejects.toThrow(/dim 8 but .* is dim 4/);
});

test('fixtureEmbed: file bytes are insertion-order independent (stable diffs)', async () => {
	const a = tmpPath();
	const b = tmpPath();
	const forward = fixtureEmbed({ path: a, embed: spyEmbed(), refresh: true });
	for (const t of ['alpha', 'beta', 'gamma']) await forward(t);
	forward.save();

	const backward = fixtureEmbed({ path: b, embed: spyEmbed(), refresh: true });
	for (const t of ['gamma', 'beta', 'alpha']) await backward(t);
	backward.save();

	expect(readFileSync(a, 'utf8')).toBe(readFileSync(b, 'utf8'));
});

test('fixtureEmbed: save() is a no-op when nothing new was recorded', async () => {
	const path = tmpPath();
	const rec = fixtureEmbed({ path, embed: spyEmbed(), refresh: true });
	await rec('once');
	expect(rec.save()).toBe(true);
	expect(rec.save()).toBe(false); // already flushed

	const replay = fixtureEmbed({ path });
	await replay('once');
	expect(replay.save()).toBe(false); // pure hits never rewrite the file
});

test('fixtureEmbed: dim reports the fixture width; a malformed file is rejected', async () => {
	const path = tmpPath();
	expect(fixtureEmbed({ path }).dim).toBeNull();

	const rec = fixtureEmbed({ path, embed: spyEmbed(4), refresh: true });
	await rec('sized');
	rec.save();
	expect(fixtureEmbed({ path }).dim).toBe(4);

	const bad = tmpPath();
	writeFileSync(bad, JSON.stringify({ nope: true }));
	expect(() => fixtureEmbed({ path: bad })).toThrow(/not a fixture file/);
});
