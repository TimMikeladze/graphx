import { defineEmbedder, type Embedder, EmbeddingError } from '../core/embedder.ts';

/**
 * `graphx/embedders` — `fetch`-based adapters for hosted and local embedding models. No SDKs:
 * each is one HTTP call, so importing this subpath adds no dependency and no install weight.
 *
 * Every adapter returns an {@link Embedder} whose `id` is `<provider>:<model>`, so a namespace
 * initialised through one is recognised (or refused) by the same model later, and whose width is
 * probed on first use unless `dim` is given.
 */

interface FetchLike {
	(input: string, init: RequestInit): Promise<Response>;
}

/** Options shared by the hosted adapters. */
export interface HostedEmbedderOptions {
	/** API key. Defaults to the provider's conventional environment variable. */
	apiKey?: string;
	/** Override the API base URL (proxies, gateways, self-hosted endpoints). */
	baseUrl?: string;
	/** Output width, when the model supports choosing one (OpenAI `dimensions`). */
	dim?: number;
	/** Texts per request. Default 64. */
	batchSize?: number;
	/** Truncate inputs to this many characters before sending. */
	maxChars?: number;
	/** Injectable for tests. Defaults to the global `fetch`. */
	fetch?: FetchLike;
}

async function postJson(
	fetchImpl: FetchLike,
	url: string,
	headers: Record<string, string>,
	body: unknown,
	provider: string,
): Promise<unknown> {
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new EmbeddingError(
			'invalid',
			`${provider}: embedding request failed with HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
		);
	}
	return res.json();
}

function requireKey(provider: string, key: string | undefined, envVar: string): string {
	if (!key) {
		throw new EmbeddingError(
			'invalid',
			`${provider}: no API key — pass { apiKey } or set ${envVar}`,
		);
	}
	return key;
}

/**
 * OpenAI embeddings (`text-embedding-3-small`, `text-embedding-3-large`, ...). `dim` maps to the
 * API's `dimensions` parameter for the models that support shortening.
 */
export function openai(
	model = 'text-embedding-3-small',
	opts: HostedEmbedderOptions = {},
): Embedder {
	const fetchImpl = opts.fetch ?? fetch;
	const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
	return defineEmbedder({
		id: `openai:${model}${opts.dim ? `:${opts.dim}` : ''}`,
		dim: opts.dim,
		batchSize: opts.batchSize,
		maxChars: opts.maxChars,
		embed: async (texts) => {
			const key = requireKey('openai', opts.apiKey ?? process.env.OPENAI_API_KEY, 'OPENAI_API_KEY');
			const json = (await postJson(
				fetchImpl,
				`${base}/embeddings`,
				{ authorization: `Bearer ${key}` },
				{ model, input: texts, ...(opts.dim ? { dimensions: opts.dim } : {}) },
				'openai',
			)) as { data: Array<{ index: number; embedding: number[] }> };
			return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
		},
	});
}

/** Voyage AI embeddings (`voyage-3`, `voyage-3-lite`, `voyage-code-3`, ...). */
export function voyage(model = 'voyage-3', opts: HostedEmbedderOptions = {}): Embedder {
	const fetchImpl = opts.fetch ?? fetch;
	const base = (opts.baseUrl ?? 'https://api.voyageai.com/v1').replace(/\/$/, '');
	return defineEmbedder({
		id: `voyage:${model}`,
		dim: opts.dim,
		batchSize: opts.batchSize,
		maxChars: opts.maxChars,
		embed: async (texts) => {
			const key = requireKey('voyage', opts.apiKey ?? process.env.VOYAGE_API_KEY, 'VOYAGE_API_KEY');
			const json = (await postJson(
				fetchImpl,
				`${base}/embeddings`,
				{ authorization: `Bearer ${key}` },
				{ model, input: texts },
				'voyage',
			)) as { data: Array<{ index: number; embedding: number[] }> };
			return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
		},
	});
}

/** Options for {@link ollama}. */
export interface OllamaEmbedderOptions {
	/** Ollama server. Default `http://localhost:11434`. */
	baseUrl?: string;
	dim?: number;
	batchSize?: number;
	maxChars?: number;
	fetch?: FetchLike;
}

/** A local Ollama model (`nomic-embed-text`, `mxbai-embed-large`, ...) over its `/api/embed` route. */
export function ollama(model = 'nomic-embed-text', opts: OllamaEmbedderOptions = {}): Embedder {
	const fetchImpl = opts.fetch ?? fetch;
	const base = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
	return defineEmbedder({
		id: `ollama:${model}`,
		dim: opts.dim,
		batchSize: opts.batchSize,
		maxChars: opts.maxChars,
		embed: async (texts) => {
			const json = (await postJson(
				fetchImpl,
				`${base}/api/embed`,
				{},
				{ model, input: texts },
				'ollama',
			)) as { embeddings: number[][] };
			return json.embeddings;
		},
	});
}
