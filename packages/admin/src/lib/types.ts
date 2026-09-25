/**
 * Wire DTOs for the graphx HTTP API — local mirrors of the shapes returned by
 * `packages/graphx` (`src/core/serve.ts` + `src/core/admin.ts`). Defined here rather than imported
 * from `graphx` because the Vite app has no `dist/` build to resolve types against. Keep these in
 * sync with the server's response shapes.
 */

/** A tenant membership role (control plane). */
export type Role = 'owner' | 'editor' | 'viewer';

/** Control-plane tenant. */
export interface Tenant {
	id: string;
	name: string;
}

/** Control-plane project (one libSQL namespace per project). */
export interface Project {
	id: string;
	name: string;
	dbNamespace: string;
}

/** Control-plane user. */
export interface User {
	id: string;
	email: string;
}

/**
 * The JSON Schema subset the node editor reads. The server derives it from the project's zod
 * schema (`GET /schema`), so anything zod can express may appear — the form engine renders what
 * it recognizes and falls back to a JSON field for the rest.
 */
export interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	enum?: unknown[];
	default?: unknown;
	description?: string;
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	[key: string]: unknown;
}

/** One declared node type and the shape of its `data`. */
export interface SchemaNodeType {
	type: string;
	jsonSchema: JsonSchema;
}

/** One declared relation. `from`/`to` are `null` when the rel accepts any endpoint type. */
export interface SchemaEdgeRel {
	rel: string;
	from: string[] | null;
	to: string[] | null;
	single: boolean;
	jsonSchema: JsonSchema | null;
}

/** `GET /schema` — the project's declared node types and relations. */
export interface SchemaDoc {
	nodes: SchemaNodeType[];
	edges: SchemaEdgeRel[];
}

/** A live node as returned by `getNode`/`listNodes` ({ id, type, parsed data }). */
export interface GraphNode {
	id: string;
	type: string;
	data: Record<string, unknown>;
}

/**
 * `GET /nodes/:id/content` — the live version's text payload and its provenance. `uri` is set
 * for ingest-sourced nodes (the source file key) and `null` for nodes authored here.
 */
export interface NodeContent {
	body: string | null;
	uri: string | null;
	contentType: string | null;
	contentHash: string | null;
}

/** One keyset page of `GET /nodes`. */
export interface NodeListPage {
	nodes: GraphNode[];
	nextCursor: string | null;
}

/** A canvas node in a graph slice. */
export interface GraphSliceNode {
	id: string;
	type: string;
	/** Server-derived display label (the node's name/title/…); absent when data carries none. */
	label?: string;
	/**
	 * Server-derived avatar/thumbnail URL (the node's image/avatar/… property); absent when data
	 * carries none. Always an absolute http(s) URL — the server rejects every other scheme, so it
	 * is safe to put straight into an `<img src>`.
	 */
	image?: string;
}

/** A canvas link in a graph slice (Cosmograph `source`/`target` naming). */
export interface GraphSliceLink {
	id: string;
	source: string;
	target: string;
	rel: string;
	weight: number;
}

/** `GET /graph` — the filtered node set + edges among them. */
export interface GraphSlice {
	nodes: GraphSliceNode[];
	links: GraphSliceLink[];
	/** True when the node set hit the server row cap. */
	truncated: boolean;
}

/** One row of `GET /nodes/:id/history` (raw stored version; `data` is JSON text). */
export interface NodeVersion {
	ver: number;
	id: string;
	type: string;
	body: string | null;
	uri: string | null;
	content_hash: string | null;
	content_type: string | null;
	data: string;
	valid_from: number;
	valid_to: number;
}

/**
 * How the `q` filter is executed.
 *  - `text`     — substring filter on `GET /nodes` (the default; no embedder needed).
 *  - `semantic` — `GET /retrieve`: ANN seeds over the vector index, expanded by a graph walk.
 *  - `hybrid`   — `POST /hybrid`: ANN + full-text seeds fused by RRF, then the same walk.
 */
export type SearchMode = 'text' | 'semantic' | 'hybrid';

/** One row of `GET /retrieve` / `POST /hybrid`. `depth` 0 = seed, ≥1 = reached by the walk. */
export interface RetrievedNode {
	id: string;
	type: string;
	data: Record<string, unknown>;
	body: string | null;
	uri: string | null;
	/** 0 = seed, ≥1 = reached by the walk. */
	depth: number;
	/** Cosine similarity (vector seed) or RRF score (hybrid seed); `null` for walked rows. */
	score: number | null;
	via: Array<'vector' | 'fts' | 'walk'>;
	/** The seed whose walk reached this row. */
	seed: string;
	/** The best-matching chunk when the type is chunked. */
	snippet: string | null;
}

/**
 * Which canvas draws the slice.
 *  - `cosmograph` — WebGL force canvas; the default, and the only one that survives a big slice.
 *  - `flow`       — xyflow: DOM cards, deterministic layout, readable at a few hundred nodes.
 */
export type Renderer = 'cosmograph' | 'flow';

/** How the xyflow renderer places its nodes: dagre ranks, or a d3-force settle. */
export type FlowLayout = 'layered' | 'organic';

/** The viewport commands the shared toolbar issues, whichever renderer is mounted. */
export interface RendererHandle {
	fit: () => void;
	zoomIn: () => void;
	zoomOut: () => void;
}

/**
 * `GET /timeline` — the graph's change points, aggregated for the scrubber. A change point is any
 * `valid_from` plus any non-FOREVER `valid_to`, so retractions are represented.
 */
export interface Timeline {
	/** Extent over all time, ignoring the requested window. `null` on an empty graph. */
	min: number | null;
	max: number | null;
	/** Change-point count over the full extent. */
	total: number;
	/** The window the server actually bucketed. */
	from: number;
	to: number;
	/** Change-point counts per equal-width slot over `[from, to]`. */
	buckets: number[];
	/**
	 * Distinct change instants in the window, ascending — what the handle snaps to.
	 *
	 * On truncation this is a SAMPLE spread evenly across the window (every k-th instant by rank,
	 * always including both ends), not the earliest or most-recent N.
	 */
	ticks: number[];
	/** True when `ticks` is a sample rather than the exact list — narrow the window (`from`/`to`) for exact precision. */
	ticksTruncated: boolean;
}

/** Filters that scope the explorer (also the URL search params). */
export interface ExplorerFilters {
	type?: string;
	q?: string;
	/** As-of epoch ms; absent ⇒ current (live). */
	asOf?: number;
	/** Absent ⇒ `text`. */
	mode?: SearchMode;
}

/** One edge as `GET /edges` returns it — its weight, data and provenance tag. */
export interface EdgeRecord {
	id: string;
	rel: string;
	src: string;
	dst: string;
	weight: number;
	data: Record<string, unknown>;
	source: string | null;
}

/** `GET /edges` — one keyset page. */
export interface EdgeListPage {
	edges: EdgeRecord[];
	nextCursor: string | null;
}
