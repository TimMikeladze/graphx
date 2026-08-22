import '@/hooks/dom-setup.ts';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import type { GraphSlice } from '@/lib/types';

/**
 * Records every `points` array handed to Cosmograph, and hands the test the callbacks Cosmograph
 * would normally invoke itself.
 *
 * `@cosmograph/react` is mocked rather than driven for real because the defect under test is
 * about *when* a slice is handed over, not about what Cosmograph draws: the library's
 * `ConfigManager.setConfig` overwrites its single in-flight update promise instead of queueing,
 * so a slice arriving mid-ingest interleaves its DuckDB table swap with the previous run's reads
 * and the graph dies with `Catalog Error: Table with name cosmograph_points does not exist!`.
 * What this file pins is that we never issue that second handover while the first is in flight.
 */
const handovers: string[][] = [];
/**
 * Signature of the data Cosmograph last actually ingested. The real library deep-compares the
 * `points`/`links` it is handed against its current config and skips the entire ingest when they
 * match — no upload, no rebuild, and no `onGraphRebuilt`. `rebuild()` below reproduces that, so a
 * canvas that waits on the callback for a no-op handover fails here rather than in the browser.
 */
let ingested: string | undefined;
let mounted = false;
let currentProps: { points: { id: string }[]; onGraphRebuilt?: () => void } | undefined;
/** Every props object the canvas has handed to `<Cosmograph>`, for the stability check below. */
const propSnapshots: Record<string, unknown>[] = [];

/** Drive the callback the way the library would: only when the data really changed. */
function rebuild() {
	if (!currentProps) return;
	const signature = JSON.stringify(currentProps.points.map((p) => p.id));
	if (signature === ingested) return;
	ingested = signature;
	currentProps.onGraphRebuilt?.();
}

mock.module('@cosmograph/react', () => ({
	Cosmograph: (props: {
		points: { id: string }[];
		onGraphRebuilt?: () => void;
		onMount?: (ref: unknown) => void;
	}) => {
		handovers.push(props.points.map((p) => p.id));
		currentProps = props;
		propSnapshots.push({ ...(props as Record<string, unknown>) });
		// The real wrapper constructs the graph once and hands the instance back on first mount only.
		if (!mounted) {
			mounted = true;
			props.onMount?.({
				pause: () => {},
				start: () => {},
				fitView: () => {},
				selectPoint: () => {},
				selectPoints: () => {},
				zoomToPoint: () => {},
			});
		}
		return createElement('div', { 'data-testid': 'cosmograph' });
	},
}));

const { GraphCanvas } = await import('./graph-canvas');

function slice(...ids: string[]): GraphSlice {
	return {
		nodes: ids.map((id) => ({ id, type: 'person', data: {} })),
		links: [],
		truncated: false,
	} as unknown as GraphSlice;
}

function renderCanvas(s: GraphSlice, onBusyChange?: (busy: boolean) => void) {
	return render(
		createElement(GraphCanvas, {
			slice: s,
			onSelect: () => {},
			labels: { source: 'off', edges: false, images: false, limit: 20 },
			paused: false,
			onPausedChange: () => {},
			onBusyChange,
			handleRef: { current: null },
		} as never),
	);
}

afterEach(() => {
	cleanup();
	handovers.length = 0;
	propSnapshots.length = 0;
	ingested = undefined;
	mounted = false;
	currentProps = undefined;
});

describe('GraphCanvas slice handover', () => {
	it('holds a new slice back until Cosmograph reports the previous one absorbed', () => {
		const { rerender } = renderCanvas(slice('a'));
		expect(handovers.at(-1)).toEqual(['a']);

		// A second slice arrives while the first is still being ingested. Handing it over here is
		// exactly what corrupts Cosmograph's DuckDB catalog, so it must be withheld.
		act(() => {
			rerender(
				createElement(GraphCanvas, {
					slice: slice('b'),
					onSelect: () => {},
					labels: { source: 'off', edges: false, images: false, limit: 20 },
					paused: false,
					onPausedChange: () => {},
					handleRef: { current: null },
				} as never),
			);
		});
		expect(handovers.at(-1)).toEqual(['a']);

		act(() => rebuild());
		expect(handovers.at(-1)).toEqual(['b']);
	});

	it('drops superseded slices — the newest pending one wins', () => {
		const props = (s: GraphSlice) =>
			createElement(GraphCanvas, {
				slice: s,
				onSelect: () => {},
				labels: { source: 'off', edges: false, images: false, limit: 20 },
				paused: false,
				onPausedChange: () => {},
				handleRef: { current: null },
			} as never);

		const { rerender } = renderCanvas(slice('a'));
		act(() => rerender(props(slice('b'))));
		act(() => rerender(props(slice('c'))));
		act(() => rerender(props(slice('d'))));
		expect(handovers.at(-1)).toEqual(['a']);

		// Only the last slice is worth drawing; b and c were never on screen and are skipped.
		act(() => rebuild());
		expect(handovers.at(-1)).toEqual(['d']);
		expect(handovers.map((h) => h.join())).not.toContain('b');
		expect(handovers.map((h) => h.join())).not.toContain('c');
	});

	it('reports busy while a slice is in flight and idle once it lands', () => {
		const seen: boolean[] = [];
		const { rerender } = renderCanvas(slice('a'), (b) => seen.push(b));
		act(() => rebuild());
		expect(seen.at(-1)).toBe(false);

		act(() =>
			rerender(
				createElement(GraphCanvas, {
					slice: slice('b'),
					onSelect: () => {},
					labels: { source: 'off', edges: false, images: false, limit: 20 },
					paused: false,
					onPausedChange: () => {},
					onBusyChange: (b: boolean) => seen.push(b),
					handleRef: { current: null },
				} as never),
			),
		);
		expect(seen.at(-1)).toBe(true);

		act(() => rebuild());
		expect(seen.at(-1)).toBe(false);
	});

	/**
	 * `Cosmograph` is `React.memo`-wrapped and its update effect keys on the props object, so ANY
	 * prop that takes a new identity issues another `setConfig` — and one landing mid-ingest is the
	 * re-entrancy that corrupts the library's DuckDB catalog. A re-render that changes nothing about
	 * the graph must therefore change nothing about the props. This is the guard on the hoisted
	 * literals and memoized callbacks in `graph-canvas.tsx`; an inline arrow or object literal
	 * reintroduced into that JSX fails here.
	 */
	it('passes referentially identical props on a render that changes no graph data', () => {
		// `labels` is state in GraphShell and `onPausedChange` is its `setPaused`, so both are stable
		// across a parent render in the real app; `onSelect` is the one that genuinely is not.
		const LABELS = { source: 'off', edges: false, images: false, limit: 20 };
		const onPausedChange = () => {};
		const handleRef = { current: null };
		const props = (s: GraphSlice, onSelect: (id: string | undefined) => void) =>
			createElement(GraphCanvas, {
				slice: s,
				onSelect,
				labels: LABELS,
				paused: false,
				onPausedChange,
				handleRef,
			} as never);

		const same = slice('a', 'b');
		const { rerender } = render(props(same, () => {}));
		act(() => rebuild());
		const before = propSnapshots.at(-1) as Record<string, unknown>;

		// A fresh `onSelect` arrow is what `ExplorerPage` supplies on every one of its renders.
		act(() => rerender(props(same, () => {})));
		const after = propSnapshots.at(-1) as Record<string, unknown>;

		expect(after).not.toBe(before);
		const unstable = Object.keys(after).filter((k) => !Object.is(after[k], before[k]));
		expect(unstable).toEqual([]);
	});

	/**
	 * Every as-of step re-fetches under a new query key, so an unchanged graph still arrives as a
	 * fresh array. Cosmograph deep-compares and skips such an update entirely — it never reports a
	 * rebuild — so a canvas that armed its gate on one would wait for a callback that never comes,
	 * and the next real slice would sit undrawn behind it.
	 */
	it('does not wait on a slice that draws the same graph', () => {
		const seen: boolean[] = [];
		const props = (s: GraphSlice) =>
			createElement(GraphCanvas, {
				slice: s,
				onSelect: () => {},
				labels: { source: 'off', edges: false, images: false, limit: 20 },
				paused: false,
				onPausedChange: () => {},
				onBusyChange: (b: boolean) => seen.push(b),
				handleRef: { current: null },
			} as never);

		const { rerender } = renderCanvas(slice('a', 'b'), (b) => seen.push(b));
		act(() => rebuild());
		expect(seen.at(-1)).toBe(false);

		// Same graph, new arrays. Nothing to draw and nothing to wait for.
		act(() => rerender(props(slice('a', 'b'))));
		expect(seen.at(-1)).toBe(false);

		// The gate is still open, so a genuinely different slice goes over at once.
		act(() => rerender(props(slice('a', 'b', 'c'))));
		expect(handovers.at(-1)).toEqual(['a', 'b', 'c']);
		expect(seen.at(-1)).toBe(true);
	});
});
