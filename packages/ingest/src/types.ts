import type { EmbedFn, Graph, GraphSchema } from 'core';

/** A parsed source file. `key` is the relative POSIX path from the vault root. */
export interface ParsedFile {
	key: string;
	/** Full raw file contents (the hash input). */
	raw: string;
	/** sha256 hex of `raw`. */
	hash: string;
	/** Parsed YAML frontmatter (empty object if none). */
	frontmatter: Record<string, unknown>;
	/** Markdown body, frontmatter stripped (empty string for pure-YAML files). */
	body: string;
}

export interface IngestOptions<S extends GraphSchema> {
	/** Local vault root. */
	dir: string;
	/** Target graph, already bound to its DbClient + schema. */
	graph: Graph<S>;
	/** Embedding function — required (embeddings-on scope). */
	embed: EmbedFn;
	/** File extensions to include (lowercase, with dot). Default: .md/.markdown/.yml/.yaml */
	include?: string[];
	/** Override kind resolution. Default: frontmatter.kind ?? top-level folder name. */
	kindOf?: (file: ParsedFile) => string | undefined;
	/**
	 * Logical source id, used to namespace the node `uri` (`ingest:<source>:<key>`) so this
	 * ingest only ever reconciles — and, with deletion, prunes — its OWN nodes. Two vaults
	 * ingested into one graph MUST use distinct sources or they reconcile each other.
	 * Default: `'default'`.
	 */
	source?: string;
	/**
	 * Retract nodes for files that vanished from the source since the last run (live-map
	 * entries with no matching discovered file), plus their incident edges. Off by default —
	 * pointing ingest at a partial or empty directory would otherwise silently retract the
	 * whole source. The pruned set is scoped to this `source`.
	 */
	prune?: boolean;
	/**
	 * Frontmatter field name → edge relation. Each configured field's value(s) become typed
	 * edges and are excluded from stored node props. Value forms: a wikilink string `"[[t]]"`,
	 * a bare basename `"t"`, an object `{ target, weight?, props? }`, or an array mixing these.
	 */
	edgeFields?: Record<string, string>;
}

/** Pipeline stage at which a file/link/edge was skipped. */
export type SkipStage = 'kind' | 'node' | 'link' | 'edge';

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
