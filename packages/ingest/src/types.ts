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
}

export interface IngestResult {
	added: number;
	updated: number;
	unchanged: number;
	edgesAdded: number;
	edgesClosed: number;
	/** Files/links skipped, with a reason (no kind, schema reject, unresolved link). */
	skipped: Array<{ key: string; reason: string }>;
}
