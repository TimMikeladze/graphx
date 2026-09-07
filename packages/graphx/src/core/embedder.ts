import { createHash } from 'node:crypto';

/**
 * Embedders, embedding input, chunking, and the errors the embedding layer raises.
 *
 * An {@link Embedder} is the one thing a graph needs to know about a model: a stable `id`,
 * a width, and a batch `embed`. `defineEmbedder` wraps a user's function with the checks
 * every call site used to repeat — width validation, batching, dimension probing — so the
 * rest of the codebase can treat vectors as already-correct.
 */

/** What an {@link EmbeddingError} is about. Drives the HTTP status in `serve.ts`. */
export type EmbeddingErrorCode = 'dimension' | 'model' | 'missing' | 'invalid';

/** A graphx-owned embedding failure, raised BEFORE any SQL runs. */
export class EmbeddingError extends Error {
	constructor(
		readonly code: EmbeddingErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'EmbeddingError';
	}
}

/** Text in, one vector per text out. Batch-first: every real API is. */
export type EmbedBatchFn = (texts: string[]) => Promise<number[][]>;

export interface EmbedderConfig {
	/**
	 * Stable model identity, e.g. `'openai:text-embedding-3-small'`. Recorded in the namespace
	 * on first init; a different id later is refused until `reembed` runs. It is also mixed into
	 * every stored `embed_hash`, so swapping models re-embeds even byte-identical text.
	 */
	id: string;
	/** Output width. Omit to have it probed once (one call with a constant string) and cached. */
	dim?: number;
	embed: EmbedBatchFn;
	/** Texts per `embed` call. Larger batches are split. Default 64. */
	batchSize?: number;
	/** Inputs longer than this are truncated before embedding. Default: no limit. */
	maxChars?: number;
}

/** A validated, batching embedder. Build one with {@link defineEmbedder}. */
export interface Embedder {
	readonly id: string;
	/** The width, once known. `undefined` until the first embed or {@link resolveDim}. */
	readonly dim: number | undefined;
	/** Embed a batch. Every returned vector is checked to be finite and of the same width. */
	embed(texts: string[]): Promise<number[][]>;
	/** Embed one text. */
	embedOne(text: string): Promise<number[]>;
	/** The width, probing the model if it is not yet known. */
	resolveDim(): Promise<number>;
	readonly maxChars: number | undefined;
}

/** The constant string {@link Embedder.resolveDim} embeds when the width is unknown. */
const PROBE_TEXT = 'graphx';

/** Reject a vector that would corrupt the index: wrong width, NaN, or ±Infinity. */
export function assertVector(vec: number[], dim: number | undefined, context: string): void {
	if (dim !== undefined && vec.length !== dim) {
		throw new EmbeddingError(
			'dimension',
			`${context}: vector has ${vec.length} dimensions but this namespace is embedded at ${dim}`,
		);
	}
	for (let i = 0; i < vec.length; i++) {
		const x = vec[i] as number;
		if (typeof x !== 'number' || !Number.isFinite(x)) {
			throw new EmbeddingError(
				'invalid',
				`${context}: vector component ${i} is not a finite number`,
			);
		}
	}
}

/**
 * Wrap a batch embedding function into an {@link Embedder}: splits batches, truncates inputs,
 * checks every returned vector, and learns the width from the first result.
 */
export function defineEmbedder(cfg: EmbedderConfig): Embedder {
	if (!cfg.id) throw new EmbeddingError('invalid', 'defineEmbedder: `id` is required');
	const batchSize = Math.max(1, cfg.batchSize ?? 64);
	let dim: number | undefined = cfg.dim;

	const prepare = (text: string): string =>
		cfg.maxChars !== undefined && text.length > cfg.maxChars ? text.slice(0, cfg.maxChars) : text;

	async function embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += batchSize) {
			const part = texts.slice(i, i + batchSize).map(prepare);
			const vecs = await cfg.embed(part);
			if (!Array.isArray(vecs) || vecs.length !== part.length) {
				throw new EmbeddingError(
					'invalid',
					`embedder '${cfg.id}' returned ${Array.isArray(vecs) ? vecs.length : 'a non-array'} vectors for ${part.length} inputs`,
				);
			}
			for (const v of vecs) {
				if (dim === undefined) dim = v.length;
				assertVector(v, dim, `embedder '${cfg.id}'`);
				out.push(v);
			}
		}
		return out;
	}

	return {
		id: cfg.id,
		get dim() {
			return dim;
		},
		maxChars: cfg.maxChars,
		embed,
		embedOne: async (text) => (await embed([text]))[0] as number[],
		resolveDim: async () => {
			if (dim === undefined) await embed([PROBE_TEXT]);
			return dim as number;
		},
	};
}

/**
 * A deterministic, model-free embedder for dev / tests / demos: a hashed bag-of-tokens vector of
 * width `dim`. Same text → same vector; texts sharing tokens share dimensions, so `retrieve` /
 * `hybridRetrieve` return sensible neighbors with NO embedding model, API key, or network. It is
 * lexical, not semantic — swap in a real model for production.
 */
export function hashEmbed(dim = 768): Embedder {
	return defineEmbedder({
		id: `hash:${dim}`,
		dim,
		embed: (texts) =>
			Promise.resolve(
				texts.map((text) => {
					const v = Array.from({ length: dim }, () => 0);
					for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
						let h = 0;
						for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
						const idx = h % dim;
						v[idx] = (v[idx] ?? 0) + 1;
					}
					return v;
				}),
			),
	});
}

// ---------------------------------------------------------------------------------------------
// Embedding input + chunking
// ---------------------------------------------------------------------------------------------

/** Per-type embedding policy, declared on `defineGraphSchema({ embedding: { [type]: ... } })`. */
export interface EmbeddingPolicy<D = Record<string, unknown>> {
	/**
	 * The text that represents a node of this type. Default: its `body`. Return `null` or an
	 * empty string to leave the node out of vector search.
	 */
	text?: (data: D, body: string | null) => string | null;
	/** Split the input into overlapping windows; each becomes one vector row. */
	chunk?: ChunkOptions;
}

export interface ChunkOptions {
	/** Target window length in characters. */
	size: number;
	/** Characters carried over from the end of one window into the start of the next. Default 0. */
	overlap?: number;
}

/** The map `defineGraphSchema` accepts under `embedding`. */
export type EmbeddingPolicies = Record<string, EmbeddingPolicy<never>>;

/** Loosened schema shape carrying the optional per-type policies. */
interface SchemaWithPolicies {
	embedding?: Record<string, EmbeddingPolicy<never> | undefined>;
}

/** The text a node of `type` is embedded from, per the schema's policy (default: `body`). */
export function embedInputFor(
	schema: SchemaWithPolicies,
	type: string,
	data: Record<string, unknown>,
	body: string | null | undefined,
): string | null {
	const policy = schema.embedding?.[type];
	const text = policy?.text
		? (policy.text as (d: Record<string, unknown>, b: string | null) => string | null)(
				data,
				body ?? null,
			)
		: (body ?? null);
	return text && text.trim().length > 0 ? text : null;
}

/** The per-type chunking, or `undefined` for one vector per node. */
export function chunkPolicyFor(schema: SchemaWithPolicies, type: string): ChunkOptions | undefined {
	return schema.embedding?.[type]?.chunk;
}

/**
 * Split `text` into windows of about `size` characters. Boundaries prefer paragraph breaks,
 * then line breaks, then whitespace, so a window rarely cuts a word. `overlap` characters from the
 * end of each window are carried into the next. Deterministic: the same text always chunks the
 * same way, which is what keeps `embed_hash` comparisons meaningful.
 */
export function chunkText(text: string, opts: ChunkOptions): string[] {
	const size = Math.max(1, Math.floor(opts.size));
	const overlap = Math.min(Math.max(0, Math.floor(opts.overlap ?? 0)), size - 1);
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + size, text.length);
		if (end < text.length) {
			// Back off to the nicest boundary inside the last third of the window.
			const floor = start + Math.floor((size * 2) / 3);
			const window = text.slice(floor, end);
			const cut = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')]
				.map((i) => (i > 0 ? floor + i : -1))
				.find((i) => i > start);
			if (cut !== undefined) end = cut;
		}
		const piece = text.slice(start, end).trim();
		if (piece.length > 0) chunks.push(piece);
		if (end >= text.length) break;
		start = Math.max(end - overlap, start + 1);
	}
	return chunks;
}

/** The staleness key stored beside every vector: the model AND the text it was computed from. */
export function embedHash(modelId: string, text: string): string {
	return createHash('sha256').update(`${modelId}\0${text}`).digest('hex');
}

/** One node's vectors, ready to write: the hash they were computed under and one row per chunk. */
export interface PreparedEmbedding {
	hash: string;
	chunks: Array<{
		chunk: number;
		/** The chunk's text, or `null` when it is the whole input (nothing worth storing twice). */
		text: string | null;
		emb: number[];
	}>;
}

/** The chunk texts for one node under its policy: `[input]` when unchunked. */
export function chunksFor(text: string, chunk: ChunkOptions | undefined): string[] {
	return chunk ? chunkText(text, chunk) : [text];
}
