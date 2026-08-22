import { expect, test } from 'bun:test';
import { generate } from './generate.ts';
import { withHistory } from './temporal.ts';

const NOW = 1_780_000_000_000;
const FOREVER = 8_640_000_000_000_000;
const base = generate({ nodes: 2000, seed: 7, now: NOW });
const hist = withHistory(base, { seed: 11, now: NOW });

test('withHistory: deterministic for a given seed', () => {
	expect(withHistory(base, { seed: 11, now: NOW }).nodes).toEqual(hist.nodes);
});

test('withHistory: adds versions without adding identities', () => {
	expect(hist.nodes.length).toBeGreaterThan(base.nodes.length);
	expect(new Set(hist.nodes.map((n) => n.id)).size).toBe(base.nodes.length);
});

test('withHistory: per id, intervals are contiguous, non-overlapping, exactly one open', () => {
	const byId = new Map<string, typeof hist.nodes>();
	for (const n of hist.nodes) {
		const group = byId.get(n.id);
		if (group) group.push(n);
		else byId.set(n.id, [n]);
	}
	for (const [, group] of byId) {
		const sorted = [...group].sort((a, b) => a.validFrom - b.validFrom);
		expect(sorted.filter((n) => (n.validTo ?? FOREVER) === FOREVER).length).toBe(1);
		// the open one must be last
		expect(sorted[sorted.length - 1]?.validTo).toBeUndefined();
		for (let i = 1; i < sorted.length; i++) {
			expect(sorted[i - 1]?.validTo).toBe(sorted[i]?.validFrom as number);
		}
		for (const n of sorted) expect(n.validFrom).toBeLessThan(n.validTo ?? FOREVER);
	}
});

test('withHistory: the live version keeps the original content', () => {
	const original = new Map(base.nodes.map((n) => [n.id, n]));
	const live = hist.nodes.filter((n) => n.validTo === undefined);
	expect(live.length).toBe(base.nodes.length);
	for (const n of live) {
		expect(n.data).toEqual(original.get(n.id)?.data as Record<string, unknown>);
		expect(n.body).toBe(original.get(n.id)?.body as string);
	}
});

test('withHistory: versioned nodes actually differ from their predecessors', () => {
	const superseded = hist.nodes.filter((n) => n.validTo !== undefined);
	expect(superseded.length).toBeGreaterThan(0);
	const original = new Map(base.nodes.map((n) => [n.id, n]));
	// At least some superseded versions carry different data than the live row (types with no
	// mutable field, like tags, legitimately repeat theirs).
	const changed = superseded.filter(
		(n) => JSON.stringify(n.data) !== JSON.stringify(original.get(n.id)?.data),
	);
	expect(changed.length).toBeGreaterThan(0);
	for (const n of superseded) expect(n.body as string).toContain('Superseded revision');
});

test('withHistory: roughly the configured fraction of nodes gains history', () => {
	const versioned = new Set(hist.nodes.filter((n) => n.validTo !== undefined).map((n) => n.id));
	const share = versioned.size / base.nodes.length;
	expect(share).toBeGreaterThan(0.02);
	expect(share).toBeLessThan(0.09);
});

test('withHistory: some edges are closed, inside their own lifetime', () => {
	const closed = hist.edges.filter((e) => e.validTo !== undefined);
	expect(closed.length).toBeGreaterThan(0);
	expect(closed.length / hist.edges.length).toBeLessThan(0.05);
	for (const e of closed) {
		expect(e.validTo as number).toBeGreaterThan(e.validFrom);
		expect(e.validTo as number).toBeLessThanOrEqual(NOW);
	}
});

test('withHistory: edge identities are untouched', () => {
	expect(hist.edges.length).toBe(base.edges.length);
	expect(hist.edges.map((e) => e.id)).toEqual(base.edges.map((e) => e.id));
});
