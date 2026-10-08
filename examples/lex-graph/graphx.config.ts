/**
 * The podcast graph's config — the one `graphx` CLI commands (`graphx doctor`, `graphx serve`,
 * `graphx mcp`) load. The schema lives in `schema.ts`; this file adds the embedder choice.
 */
import { defineConfig, type Embedder, hashEmbed } from 'graphx';
import { ollama, openai } from 'graphx/embedders';
import { podcastSchema, NAMESPACE } from './schema.ts';

export * from './schema.ts';

/**
 * `hash` is model-free and offline. `ollama` needs a local Ollama with `nomic-embed-text`;
 * `openai` needs `OPENAI_API_KEY`. A namespace records its model, so switching later means
 * `graphx reembed` (or a fresh database).
 */
export function embedderFor(name: string = process.env.PODCAST_EMBEDDER ?? 'hash'): Embedder {
	if (name === 'hash') return hashEmbed(256);
	if (name === 'ollama') return ollama(process.env.OLLAMA_MODEL ?? 'nomic-embed-text');
	if (name === 'openai') return openai(process.env.OPENAI_MODEL ?? 'text-embedding-3-small');
	throw new Error(`unknown embedder '${name}' — use hash, ollama or openai`);
}

export default defineConfig({
	schema: podcastSchema,
	embedder: embedderFor(),
	namespace: NAMESPACE,
});
