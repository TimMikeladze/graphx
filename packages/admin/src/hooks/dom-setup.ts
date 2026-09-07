/**
 * Register a DOM into the global scope so `@testing-library/react` can render hooks under Bun.
 * Imported FIRST by every `.test.ts` file that renders a hook (before `@testing-library/react`).
 * Idempotent across files — see the process-wide caveat below.
 *
 * This inlines what `@happy-dom/global-registrator` does (copy every own property of a fresh
 * `happy-dom` window onto `globalThis`) using only `happy-dom`'s own exports, rather than adding
 * that package as a third dependency: this plan's no-new-dependencies rule was given a scoped
 * exception for exactly two packages, `@testing-library/react` and `happy-dom` (both already
 * present in `node_modules`, hoisted from `packages/graphx`'s devDependencies) — see the code
 * review on this task. `GlobalWindow` and `PropertySymbol` are both public exports of `happy-dom`
 * itself; `@happy-dom/global-registrator`'s own source (also vendored in this monorepo, via
 * `packages/graphx`) is a thin wrapper around them, reproduced here.
 *
 * Two adjustments to the naive "copy every descriptor" version were needed against Bun 1.3:
 *  - Skip a key when Bun's global already holds the identical value happy-dom would install
 *    (mirrors the registrator's own check) — without it, `Object.defineProperty` throws on a
 *    handful of primordials Bun exposes as non-configurable.
 *  - Restore Bun's native `fetch`/`Response`/etc. after registering (see PLATFORM_GLOBALS below).
 *
 * This module evaluates ONCE per process, so it cannot scope an `afterAll` unregister to a single
 * file — whatever it leaves on `globalThis` is what every later test file sees. Test files are not
 * run in a guaranteed order, so "the DOM only leaks into files that come after this one" is not
 * something to rely on. `packages/graphx/test/react/dom-setup.ts` hit exactly this with its own
 * `@happy-dom/global-registrator` copy — its core's native-HTTP tests failed for weeks because a
 * leaked happy-dom `Response` fails `Bun.serve`'s "Expected a Response object" check. The fix there
 * (and here) is the same: keep happy-dom's DOM, keep Bun's platform primitives.
 */
import { notifyManager } from '@tanstack/react-query';
import { GlobalWindow, PropertySymbol } from 'happy-dom';

const IGNORE_LIST = new Set(['constructor', 'undefined', 'NaN', 'global', 'globalThis']);

const PLATFORM_GLOBALS = [
	'fetch',
	'Response',
	'Request',
	'Headers',
	'AbortController',
	'AbortSignal',
	'WritableStream',
	'TransformStream',
	'Blob',
	'File',
	'FormData',
	'URL',
] as const;

const scope = globalThis as unknown as Record<string, unknown>;
const native = new Map<string, unknown>(PLATFORM_GLOBALS.map((key) => [key, scope[key]]));

if (!(globalThis as { document?: unknown }).document) {
	const win = new GlobalWindow({ console: globalThis.console }) as unknown as Record<
		string | symbol,
		unknown
	>;

	for (const key of Object.keys(Object.getOwnPropertyDescriptors(win))) {
		if (IGNORE_LIST.has(key)) continue;
		const winDescriptor = Object.getOwnPropertyDescriptor(win, key) as PropertyDescriptor;
		const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		// Same value already — skip. A handful of Bun's own globals are non-configurable, so
		// re-defining one that already matches (rather than merely being present) throws.
		if (globalDescriptor?.value !== undefined && globalDescriptor.value === winDescriptor.value)
			continue;
		if (winDescriptor.value === win) winDescriptor.value = globalThis;
		Object.defineProperty(globalThis, key, { ...winDescriptor, configurable: true });
	}

	for (const sym of Object.getOwnPropertySymbols(win)) {
		const winDescriptor = Object.getOwnPropertyDescriptor(win, sym);
		if (!winDescriptor) continue;
		if (winDescriptor.value === win) winDescriptor.value = globalThis;
		Object.defineProperty(globalThis, sym, { ...winDescriptor, configurable: true });
	}

	// Owner window of `document` must be the global scope, not the discarded `win` object.
	const doc = (globalThis as unknown as { document: Record<PropertyKey, unknown> }).document;
	doc[(PropertySymbol as unknown as { defaultView: symbol }).defaultView] = globalThis;
}

for (const [key, value] of native) scope[key] = value;

// Flush React Query notifications synchronously in tests so background state updates (triggered
// by mutation invalidation) land inside `act(...)` — no "not wrapped in act" noise.
notifyManager.setScheduler((cb) => {
	cb();
});
