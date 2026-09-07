import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { defineEmbedder, type Embedder } from './embedder.ts';

/**
 * Record/replay {@link Embedder} — real model vectors, committed to disk, replayed offline.
 *
 * {@link hashEmbed} is a hashed bag-of-tokens: it exercises the vector plumbing (dimension,
 * storage, ANN SQL, RRF fusion, temporal filtering) but is LEXICAL, so it can never test
 * retrieval *quality*. A real model can, but costs an API key, a network round trip, and
 * determinism. This closes the gap: wrap the real embedder once with `UPDATE_EMBED_FIXTURES=1`
 * to record `sha256(text) → vector` into a JSON file you commit, then every later run replays
 * from that file — real semantics, zero network, byte-identical results.
 *
 * ```ts
 * const embedder = fixtureEmbed({ path: 'test/fixtures/emb.json', embedder: openai });
 * await retrieve(client, embedder, { query: 'who broke Enigma?' });
 * embedder.save(); // no-op unless something new was recorded
 * ```
 *
 * A miss in replay mode THROWS rather than silently falling back to a live call, so a test
 * can never quietly start depending on the network.
 */

/** One cached vector. `preview` exists purely so the committed JSON is reviewable by a human. */
interface FixtureEntry {
	preview: string;
	vector: number[];
}

/** On-disk shape. Keys are `sha256(text)` hex; `dim` is the (single) vector width. */
interface FixtureFile {
	/** The model the vectors came from. The fixture embedder reports this as its own `id`. */
	model: string;
	dim: number;
	entries: Record<string, FixtureEntry>;
}

/** Decimal places kept when recording. Cosine ranking is unaffected; the file is ~40% smaller. */
const PRECISION = 6;

/** How much of the source text to keep for review. */
const PREVIEW_CHARS = 80;

export interface FixtureEmbedOpts {
	/** JSON cache file. Created (with parent directories) on the first {@link FixtureEmbedder.save}. */
	path: string;
	/**
	 * The real embedder. Called ONLY on a cache miss while recording — never in replay mode.
	 * Omit it to build a strict replay-only embedder.
	 */
	embedder?: Embedder;
	/**
	 * Record misses instead of throwing. Defaults to whether `UPDATE_EMBED_FIXTURES` is set,
	 * so the same test file records with the env var and replays without it.
	 */
	refresh?: boolean;
}

export interface FixtureEmbedder extends Embedder {
	/** Write newly recorded vectors to `path`. No-op (returns `false`) when nothing was recorded. */
	save: () => boolean;
	/** Cache hits and freshly recorded vectors since construction. */
	readonly stats: { hits: number; recorded: number };
}

/** Stable cache key. Same text ⇒ same key across machines and runs. */
function keyOf(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function round(v: number[]): number[] {
	const f = 10 ** PRECISION;
	return v.map((x) => Math.round(x * f) / f);
}

function load(path: string, fallbackModel: string): FixtureFile {
	if (!existsSync(path)) return { model: fallbackModel, dim: 0, entries: {} };
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixtureFile>;
	if (
		typeof parsed.dim !== 'number' ||
		typeof parsed.entries !== 'object' ||
		parsed.entries === null
	) {
		throw new Error(
			`fixtureEmbed: ${path} is not a fixture file (expected { model, dim, entries })`,
		);
	}
	return {
		model: typeof parsed.model === 'string' ? parsed.model : fallbackModel,
		dim: parsed.dim,
		entries: parsed.entries,
	};
}

/**
 * Build a record/replay embedder over a JSON fixture file. See the module docstring for the
 * recording workflow. Its `id` is the recorded model's id, so a namespace embedded through the
 * fixture and one embedded through the live model agree.
 */
export function fixtureEmbed(opts: FixtureEmbedOpts): FixtureEmbedder {
	const refresh = opts.refresh ?? process.env.UPDATE_EMBED_FIXTURES !== undefined;
	const file = load(opts.path, opts.embedder?.id ?? `fixture:${opts.path}`);
	if (opts.embedder && file.dim !== 0 && file.model !== opts.embedder.id) {
		throw new Error(
			`fixtureEmbed: ${opts.path} was recorded with '${file.model}' but the embedder is '${opts.embedder.id}' — delete the fixture to re-record it.`,
		);
	}
	const stats = { hits: 0, recorded: 0 };
	let dirty = false;

	const inner = defineEmbedder({
		id: file.model,
		dim: file.dim === 0 ? undefined : file.dim,
		batchSize: opts.embedder ? 64 : 1024,
		embed: async (texts) => {
			const out: number[][] = [];
			const missing: Array<{ i: number; text: string; key: string }> = [];
			for (let i = 0; i < texts.length; i++) {
				const text = texts[i] as string;
				const hit = file.entries[keyOf(text)];
				if (hit) {
					stats.hits++;
					out[i] = hit.vector;
				} else {
					missing.push({ i, text, key: keyOf(text) });
				}
			}
			if (missing.length > 0) {
				const first = missing[0] as { text: string; key: string };
				const preview =
					first.text.length > PREVIEW_CHARS ? `${first.text.slice(0, PREVIEW_CHARS)}…` : first.text;
				if (!refresh) {
					throw new Error(
						`fixtureEmbed: no cached vector for "${preview}" (sha256 ${first.key.slice(0, 12)}) in ${opts.path}. ` +
							`Re-run with UPDATE_EMBED_FIXTURES=1 to record it.`,
					);
				}
				if (!opts.embedder) {
					throw new Error(
						`fixtureEmbed: recording "${preview}" needs a real embedder, but no \`embedder\` was provided.`,
					);
				}
				const vectors = await opts.embedder.embed(missing.map((m) => m.text));
				for (let j = 0; j < missing.length; j++) {
					const m = missing[j] as { i: number; text: string; key: string };
					const vector = round(vectors[j] as number[]);
					// One width per fixture — a mid-recording model swap would otherwise produce a
					// file that only fails much later, as an opaque dimension error.
					if (file.dim === 0) file.dim = vector.length;
					else if (vector.length !== file.dim) {
						throw new Error(
							`fixtureEmbed: embedder returned dim ${vector.length} but ${opts.path} is dim ${file.dim} — ` +
								`delete the fixture to re-record it with the new model.`,
						);
					}
					const p = m.text.length > PREVIEW_CHARS ? `${m.text.slice(0, PREVIEW_CHARS)}…` : m.text;
					file.entries[m.key] = { preview: p, vector };
					stats.recorded++;
					dirty = true;
					out[m.i] = vector;
				}
			}
			return out;
		},
	});

	return Object.assign(inner, {
		save: (): boolean => {
			if (!dirty) return false;
			mkdirSync(dirname(opts.path), { recursive: true });
			// Sort by key so the committed file is insertion-order independent — two runs that
			// embed the same texts in a different order produce identical bytes.
			const entries: Record<string, FixtureEntry> = {};
			for (const k of Object.keys(file.entries).sort()) {
				entries[k] = file.entries[k] as FixtureEntry;
			}
			writeFileSync(
				opts.path,
				`${JSON.stringify({ model: file.model, dim: file.dim, entries }, null, '\t')}\n`,
			);
			dirty = false;
			return true;
		},
		get stats() {
			return stats;
		},
	}) as FixtureEmbedder;
}
