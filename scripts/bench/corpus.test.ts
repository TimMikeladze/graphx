import { expect, test } from 'bun:test';
import {
	ALL_SCALES,
	BENCH_NOW,
	corpusFingerprint,
	corpusKey,
	isScale,
	MAX_EMBEDDED,
	SCALES,
} from './corpus.ts';

// The corpus cache is keyed by a fingerprint carried in the filename, so a stale corpus is never
// found rather than being found and invalidated. That makes the key's behavior the whole contract:
// identical inputs must hit, and anything that changes the generated data must miss.

test('corpusKey: pins the generator inputs the cache depends on', () => {
	const key = corpusKey('10k');
	expect(key.nodes).toBe(SCALES['10k']);
	expect(key.embedded).toBe(MAX_EMBEDDED);
	expect(key.now).toBe(BENCH_NOW);
});

test('corpusKey: the embedded cap does not scale with node count', () => {
	// The cap is deliberately flat across the ladder — see the module note on index build cost.
	for (const scale of ALL_SCALES) {
		expect(corpusKey(scale).embedded).toBe(MAX_EMBEDDED);
	}
});

test('fingerprint: same key, same fingerprint', () => {
	expect(corpusFingerprint(corpusKey('1k'))).toBe(corpusFingerprint(corpusKey('1k')));
});

test('fingerprint: different scales are different corpora', () => {
	const fps = ALL_SCALES.map((s) => corpusFingerprint(corpusKey(s)));
	expect(new Set(fps).size).toBe(ALL_SCALES.length);
});

test('fingerprint: a different embedded cap is a different corpus', () => {
	expect(corpusFingerprint(corpusKey('1k', 100))).not.toBe(corpusFingerprint(corpusKey('1k')));
});

test('fingerprint: every key field is load-bearing', () => {
	const base = corpusKey('1k');
	const baseFp = corpusFingerprint(base);
	for (const field of Object.keys(base) as Array<keyof typeof base>) {
		const mutated = { ...base, [field]: base[field] + 1 };
		expect(corpusFingerprint(mutated)).not.toBe(baseFp);
	}
});

test('fingerprint: short, hex, stable width — it goes in a filename', () => {
	const fp = corpusFingerprint(corpusKey('1k'));
	expect(fp).toMatch(/^[0-9a-f]{16}$/);
});

test('isScale: narrows only the ladder', () => {
	expect(isScale('10k')).toBe(true);
	expect(isScale('50k')).toBe(false);
});
