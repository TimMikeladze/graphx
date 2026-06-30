import type { EmbedFn, Graph, GraphSchema } from '@graphx/core';
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
	 * edges and are excluded from stored node props. Value forms: a wikilink string `"[[t]]"`,
	 * a bare basename `"t"`, an object `{ target, weight?, props? }`, or an array mixing these.
	 */
	edgeFields?: Record<string, string>;
	/**
	 * Maximum number of parallel embed calls during the batch-embed step. Default: 8.
	 */
	embedConcurrency?: number;
	/**
	 * Opaque embedder identity (e.g. a model id + dimension, `'openai:text-embedding-3-small:1536'`).
	 * Mixed into the stored `embed_hash` so that CHANGING it forces a re-embed of every node on the
	 * next run — even when file bodies are byte-identical. Without it, a model swap silently keeps
	 * stale vectors and query/document vectors end up in incompatible spaces. Unset = legacy
	 * behavior (`embed_hash = sha256(body)`), so existing graphs are unaffected until an id is set.
	 */
	embedId?: string;
	/**
	 * Turn `![[asset]]` / `![alt](asset)` embeds into nodes. Off by default (embeds ignored).
	 * An embed that resolves to a known ingested file becomes an edge to that node; otherwise a
	 * metadata-only asset node (`uri = ingest:<source>:asset:<path>`, `content_type` from the
	 * extension, `props.path`, empty body — no bytes; byte storage is the future blob layer) is
	 * created and linked. `kind` (asset node kind) and `rel` (default `embeds`) must be declared
	 * in the graph schema. Asset nodes are never pruned.
	 */
	assets?: { kind: string; rel?: string };
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
