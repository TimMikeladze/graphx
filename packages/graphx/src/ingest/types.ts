import type { Graph, GraphSchema } from '../core/index.ts';
import type { Source } from './source.ts';

/** A parsed source file. `key` is the relative POSIX path from the vault root. */
export interface ParsedFile {
	key: string;
	/** Full raw file contents (the hash input). */
	raw: string;
	/** sha256 hex of `raw`. */
	hash: string;
	/** sha256 hex of `body` (the embed input — differs from `hash` when frontmatter is present). */
	embedHash: string;
	/** Parsed YAML frontmatter (empty object if none). */
	frontmatter: Record<string, unknown>;
	/** Markdown body, frontmatter stripped (empty string for pure-YAML files). */
	body: string;
}

export interface IngestOptions<S extends GraphSchema> {
	/** Local vault root. Provide `dir` (filesystem sugar) OR `fileSource`. */
	dir?: string;
	/** Pluggable file source. Provide `fileSource` OR `dir`. */
	fileSource?: Source;
	/**
	 * Target graph, already bound to its DbClient + schema. Its embedder (if any) embeds the
	 * ingested bodies — batched here, one embedder call per run rather than one per file — and
	 * its per-type policies decide what text is embedded.
	 */
	graph: Graph<S>;
	/** File extensions to include (lowercase, with dot). Default: .md/.markdown/.yml/.yaml */
	include?: string[];
	/** Override type resolution. Default: frontmatter.type ?? top-level folder name. */
	typeOf?: (file: ParsedFile) => string | undefined;
	/**
	 * Drop source keys before they are read. Applied to every Source's listing, so it filters
	 * custom and S3 sources too. Hidden paths (any `.`-prefixed segment, e.g. Obsidian's
	 * `.trash/` and `.obsidian/`) are ALWAYS skipped by the filesystem source and need no
	 * predicate; use this for content-shaped noise like `*.excalidraw.md`, which is drawing JSON
	 * wearing a markdown extension.
	 *
	 * An excluded key is invisible to the whole run, the prune diff included — so adding an
	 * `exclude` and running with `prune` retracts nodes a previous run created from those files.
	 * For a filter that inspects frontmatter rather than the path, return `undefined` from
	 * {@link IngestOptions.typeOf} instead; those files are skipped but never pruned.
	 */
	exclude?: (key: string) => boolean;
	/**
	 * Logical source id, used to namespace the node `uri` (`ingest:<source>:<key>`) so this
	 * ingest only ever reconciles — and, with deletion, prunes — its OWN nodes. Two vaults
	 * ingested into one graph MUST use distinct sources or they reconcile each other.
	 * Default: `'default'`.
	 */
	source?: string;
	/**
	 * Frontmatter key that, when present, gives a file a stable logical identity (uri
	 * `ingest:<source>:id:<value>`) so a rename keeps the same node + history + edges instead
	 * of orphaning the old path. Files without it fall back to path identity
	 * (`ingest:<source>:file:<path>`); a rename of those is still delete+re-add. Default: `'id'`.
	 */
	idField?: string;
	/**
	 * Retract nodes for files that vanished from the source since the last run (live-map
	 * entries with no matching discovered file), plus their incident edges. Off by default —
	 * pointing ingest at a partial or empty directory would otherwise silently retract the
	 * whole source. The pruned set is scoped to this `source`.
	 */
	prune?: boolean;
	/**
	 * Frontmatter field name → edge relation. Each configured field's value(s) become typed
	 * edges and are excluded from stored node data. Value forms: a wikilink string `"[[t]]"`,
	 * a bare basename `"t"`, an object `{ target, weight?, data? }`, or an array mixing these.
	 */
	edgeFields?: Record<string, string>;
	/**
	 * Turn `![[asset]]` / `![alt](asset)` embeds into nodes. Off by default (embeds ignored).
	 * An embed that resolves to a known ingested file becomes an edge to that node; otherwise a
	 * metadata-only asset node (`uri = ingest:<source>:asset:<path>`, `content_type` from the
	 * extension, `data.path`, empty body — no bytes; byte storage is the future blob layer) is
	 * created and linked. `type` (asset node type) and `rel` (default `embeds`) must be declared
	 * in the graph schema. Asset nodes are never pruned.
	 */
	assets?: { type: string; rel?: string };
	/**
	 * Turn a body `[[wikilink]]` with no matching file into a stub node (`uri =
	 * ingest:<source>:dangling:<lowercased name>`, `data.name` the name as written) and link to
	 * it, instead of recording an `unresolved-link` skip. Off by default. `type` must be declared
	 * in the graph schema, and every rel that can reach a stub must accept it as a `to` type.
	 *
	 * This is Obsidian's phantom-node behavior: a link to an unwritten note is an intentional
	 * stub, not an error. Scope is deliberately narrow —
	 * - only `[[wikilinks]]`; a broken `[text](./path.md)` is a typo, not a stub;
	 * - only genuine misses, never {@link Resolution} `ambiguous` (that needs a real fix);
	 * - only body links, not `edgeFields` (those declare a relation to a specific node type,
	 *   which a stub would not satisfy).
	 *
	 * Stub nodes are never pruned, for the same reason asset nodes aren't: links are re-extracted
	 * only for CHANGED files, so a run cannot see that an unchanged note still points at a stub.
	 * Once the note gets written, links re-resolve to the real node on the next run that touches
	 * the referring file, and the stub is left orphaned — delete it explicitly if that matters.
	 */
	dangling?: { type: string };
	/**
	 * Turn tags into nodes: inline `#tags` in the body plus the frontmatter `tags` field, sharing
	 * one node per tag (`uri = ingest:<source>:tag:<lowercased>`, `data.name` the first-seen
	 * spelling). Off by default. `type` must be declared in the schema, as must `rel` (default
	 * `tagged_with`) with the tag type as its `to`.
	 *
	 * OFF BY DEFAULT ON PURPOSE. A tag shared by hundreds of notes becomes a hub with hundreds of
	 * edges, and that distorts exactly what this graph is for: it dominates pagerank/centrality
	 * and makes `retrieve`'s neighbor expansion pull in the whole tag cohort at depth 1. Obsidian
	 * can afford tag nodes because its graph is a picture; here they change query results. Turn
	 * this on when you actually want to traverse by tag, and prefer a dedicated `rel` so tag edges
	 * can be excluded from algorithm runs.
	 *
	 * `tags` stays in node `data` as well — it is metadata, not only topology. Tag nodes are never
	 * pruned, for the same reason asset and stub nodes aren't: only CHANGED files are re-scanned.
	 */
	tags?: { type: string; rel?: string };
}

/** Pipeline stage at which a file/link/edge was skipped. */
export type SkipStage = 'type' | 'node' | 'link' | 'edge';

/** A structured skip/validation entry. `reason` is human-readable; `code` is filterable; */
/** `detail` carries stage-specific data (e.g. Zod issues, ambiguous-link candidates). */
export interface SkipEntry {
	key: string;
	stage: SkipStage;
	code: string;
	reason: string;
	detail?: unknown;
}

export interface IngestResult {
	added: number;
	updated: number;
	unchanged: number;
	/** Nodes retracted because their file vanished (only when `prune` is set). */
	deleted: number;
	edgesAdded: number;
	edgesClosed: number;
	/** Files/links/edges skipped, tagged by stage + code (see {@link SkipEntry}). */
	skipped: SkipEntry[];
}
