import type { ExplorerFilters, FlowLayout, Renderer, SearchMode } from './types';

const MODES: SearchMode[] = ['text', 'semantic', 'hybrid'];

/** Coerce a raw search param into a {@link SearchMode}; `text` is the default so it stays absent. */
function parseMode(raw: unknown): SearchMode | undefined {
	return typeof raw === 'string' && MODES.includes(raw as SearchMode) && raw !== 'text'
		? (raw as SearchMode)
		: undefined;
}

/**
 * The explorer URL search params — the single source of truth for filter + selection state
 * (spec §6). Validated/parsed here so the router and every consumer agree on the shape.
 */
export interface ExplorerSearch extends ExplorerFilters {
	/** Currently inspected node id (opens the detail Sheet). */
	node?: string;
	/** Node ids the user has lazily expanded into the canvas. */
	expand: string[];
	/** Which canvas draws the slice. Absent ⇒ `cosmograph`, so the default URL stays clean. */
	renderer?: Renderer;
	/** How the flow renderer places nodes. Absent ⇒ `layered`. */
	flowLayout?: FlowLayout;
}

/** Coerce an unknown router search object into a validated {@link ExplorerSearch}. */
export function parseExplorerSearch(raw: Record<string, unknown>): ExplorerSearch {
	const str = (v: unknown): string | undefined =>
		typeof v === 'string' && v.length > 0 ? v : undefined;
	const instant = (v: unknown): number | undefined =>
		typeof v === 'number'
			? v
			: typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
				? Number(v)
				: undefined;
	return {
		type: str(raw.type),
		q: str(raw.q),
		asOf: instant(raw.asOf),
		recordedAsOf: instant(raw.recordedAsOf),
		mode: parseMode(raw.mode),
		node: str(raw.node),
		expand: parseExpand(raw.expand),
		renderer: raw.renderer === 'flow' ? 'flow' : undefined,
		flowLayout: raw.flowLayout === 'organic' ? 'organic' : undefined,
	};
}

/** The renderer the URL asks for; the force canvas is the default (and the only one that scales). */
export function rendererOf(search: ExplorerSearch): Renderer {
	return search.renderer ?? 'cosmograph';
}

/** The flow layout the URL asks for; dagre ranks are the default (the readable structured view). */
export function flowLayoutOf(search: ExplorerSearch): FlowLayout {
	return search.flowLayout ?? 'layered';
}

/** `expand` is carried as a comma-joined id list; parse to a de-duped array. */
function parseExpand(raw: unknown): string[] {
	if (Array.isArray(raw))
		return [...new Set(raw.filter((v): v is string => typeof v === 'string'))];
	if (typeof raw === 'string' && raw.length > 0) return [...new Set(raw.split(','))];
	return [];
}

/** The filter subset of the search (what the data hooks key on). */
export function filtersOf(search: ExplorerSearch): ExplorerFilters {
	return {
		type: search.type,
		q: search.q,
		asOf: search.asOf,
		recordedAsOf: search.recordedAsOf,
		mode: search.mode,
	};
}

/** Add an id to the expand set (immutably). */
export function withExpanded(search: ExplorerSearch, id: string): string[] {
	return [...new Set([...search.expand, id])];
}
