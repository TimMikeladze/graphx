import { expect, test } from 'bun:test';
import {
	applyLimit,
	decodeCursor,
	DEFAULT_LIMITS,
	encodeCursor,
	type QueryLimits,
	QueryTimeoutError,
	resolveLimits,
	withTimeout,
} from '../src/governance.ts';

// P14 — query governance primitives (§19.2, M7) + pagination cursor codec (§19.7).
// Pure units: limit merging, LIMIT-append sanitization, fail-safe timeout
// abandonment (NOT statement interrupt), opaque keyset cursor round-trip.

test('P14 gov: DEFAULT_LIMITS matches the §19.2 LIMITS constants', () => {
	expect(DEFAULT_LIMITS).toEqual({ maxRows: 10_000, maxFanout: 1000, timeoutMs: 5000 });
});

test('P14 gov: resolveLimits merges a partial over the defaults', () => {
	const r: QueryLimits = resolveLimits({ maxRows: 50 });
	expect(r).toEqual({ maxRows: 50, maxFanout: 1000, timeoutMs: 5000 });
	expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
	expect(resolveLimits(undefined)).toEqual(DEFAULT_LIMITS);
});

test('P14 gov: resolveLimits rejects degenerate SQL-inlined caps but allows a non-finite timeout', () => {
	// maxRows/maxFanout are inlined into SQL → must be finite/positive
	expect(() => resolveLimits({ maxRows: Number.NaN })).toThrow();
	expect(() => resolveLimits({ maxFanout: Number.POSITIVE_INFINITY })).toThrow();
	expect(() => resolveLimits({ maxFanout: -1 })).toThrow();
	// timeoutMs is NOT inlined into SQL; Infinity is withTimeout's documented "disable" sentinel
	expect(() => resolveLimits({ timeoutMs: Number.POSITIVE_INFINITY })).not.toThrow();
	expect(resolveLimits({ timeoutMs: Number.POSITIVE_INFINITY }).timeoutMs).toBe(
		Number.POSITIVE_INFINITY,
	);
});

test('P14 gov: applyLimit appends a sanitized integer LIMIT', () => {
	expect(applyLimit('SELECT 1', 10)).toBe('SELECT 1\nLIMIT 10');
	// floors a fractional cap to a safe integer
	expect(applyLimit('SELECT 1', 10.9)).toBe('SELECT 1\nLIMIT 10');
});

test('P14 gov: applyLimit rejects a non-finite / non-positive cap (no SQL injection surface)', () => {
	expect(() => applyLimit('SELECT 1', Number.NaN)).toThrow();
	expect(() => applyLimit('SELECT 1', 0)).toThrow();
	expect(() => applyLimit('SELECT 1', -5)).toThrow();
});

test('P14 gov: withTimeout rejects with QueryTimeoutError when the work outlives the budget', async () => {
	const never = new Promise<number>(() => {}); // never settles
	await expect(withTimeout(never, 20)).rejects.toBeInstanceOf(QueryTimeoutError);
});

test('P14 gov: withTimeout resolves the underlying value when it settles in time', async () => {
	await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
});

test('P14 gov: withTimeout with a non-positive budget is a pass-through (no guard, no dangling timer)', async () => {
	await expect(withTimeout(Promise.resolve('ok'), 0)).resolves.toBe('ok');
});

test('P14 gov: cursor codec round-trips a key tuple opaquely', () => {
	const enc = encodeCursor(['01ARZ', '01BSY']);
	expect(typeof enc).toBe('string');
	// opaque: not the raw id
	expect(enc).not.toContain('01ARZ');
	expect(decodeCursor(enc)).toEqual(['01ARZ', '01BSY']);
});

test('P14 gov: decodeCursor on a single-key cursor round-trips', () => {
	expect(decodeCursor(encodeCursor(['only']))).toEqual(['only']);
});
