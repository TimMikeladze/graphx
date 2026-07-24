import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import type { EmbedFn } from './retrieve.ts';

/**
 * Record/replay {@link EmbedFn} — real model vectors, committed to disk, replayed offline.
 *
 * {@link hashEmbed} is a hashed bag-of-tokens: it exercises the vector plumbing (dimension,
 * storage, ANN SQL, RRF fusion, temporal filtering) but is LEXICAL, so it can never test
 * retrieval *quality*. A real model can, but costs an API key, a network round trip, and
 * determinism. This closes the gap: wrap the real embedder once with `UPDATE_EMBED_FIXTURES=1`
 * to record `sha256(text) → vector` into a JSON file you commit, then every later run replays
 * from that file — real semantics, zero network, byte-identical results.
 *
 * ```ts
 * const embed = fixtureEmbed({ path: 'test/fixtures/emb.json', embed: openaiEmbed });
 * await retrieve(client, embed, { query: 'who broke Enigma?' });
 * embed.save(); // no-op unless something new was recorded
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
	embed?: EmbedFn;
	/**
	 * Record misses instead of throwing. Defaults to whether `UPDATE_EMBED_FIXTURES` is set,
	 * so the same test file records with the env var and replays without it.
	 */
	refresh?: boolean;
}

export interface FixtureEmbedder {
	(text: string): Promise<number[]>;
	/** Write newly recorded vectors to `path`. No-op (returns `false`) when nothing was recorded. */
	save: () => boolean;
	/** Cache hits and freshly recorded vectors since construction. */
	readonly stats: { hits: number; recorded: number };
	/** Vector width of the loaded fixture, or `null` when it is empty and nothing is recorded yet. */
	readonly dim: number | null;
}

/** Stable cache key. Same text ⇒ same key across machines and runs. */
function keyOf(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function round(v: number[]): number[] {
	const f = 10 ** PRECISION;
	return v.map((x) => Math.round(x * f) / f);
}

function load(path: string): FixtureFile {
	if (!existsSync(path)) return { dim: 0, entries: {} };
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as FixtureFile;
	if (typeof parsed.dim !== 'number' || typeof parsed.entries !== 'object' || parsed.entries === null) {
		throw new Error(`fixtureEmbed: ${path} is not a fixture file (expected { dim, entries })`);
	}
	return parsed;
}

/**
 * Build a record/replay embedder over a JSON fixture file. See the module docstring for the
 * recording workflow.
 */
export function fixtureEmbed(opts: FixtureEmbedOpts): FixtureEmbedder {
	const refresh = opts.refresh ?? process.env.UPDATE_EMBED_FIXTURES !== undefined;
	const file = load(opts.path);
	const stats = { hits: 0, recorded: 0 };
	let dirty = false;

	const embedder = async (text: string): Promise<number[]> => {
		const key = keyOf(text);
		const hit = file.entries[key];
		if (hit) {
			stats.hits++;
			return hit.vector;
		}
		const preview = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
		if (!refresh) {
			throw new Error(
				`fixtureEmbed: no cached vector for "${preview}" (sha256 ${key.slice(0, 12)}) in ${opts.path}. ` +
					`Re-run with UPDATE_EMBED_FIXTURES=1 to record it.`,
			);
		}
		if (!opts.embed) {
			throw new Error(
				`fixtureEmbed: recording "${preview}" needs a real embedder, but no \`embed\` was provided.`,
			);
		}
		const vector = round(await opts.embed(text));
		// One width per fixture — a mid-recording model swap would otherwise produce a file
		// that only fails much later, as an opaque dimension error from the database.
		if (file.dim === 0) file.dim = vector.length;
		else if (vector.length !== file.dim) {
			throw new Error(
				`fixtureEmbed: embedder returned dim ${vector.length} but ${opts.path} is dim ${file.dim} — ` +
					`delete the fixture to re-record it with the new model.`,
			);
		}
		file.entries[key] = { preview, vector };
		stats.recorded++;
		dirty = true;
		return vector;
	};

	return Object.defineProperties(embedder, {
		save: {
			value: (): boolean => {
				if (!dirty) return false;
				mkdirSync(dirname(opts.path), { recursive: true });
				// Sort by key so the committed file is insertion-order independent — two runs that
				// embed the same texts in a different order produce identical bytes.
				const entries: Record<string, FixtureEntry> = {};
				for (const k of Object.keys(file.entries).sort()) {
					entries[k] = file.entries[k] as FixtureEntry;
				}
				writeFileSync(opts.path, `${JSON.stringify({ dim: file.dim, entries }, null, '\t')}\n`);
				dirty = false;
				return true;
			},
		},
		stats: { get: () => stats },
		dim: { get: () => (file.dim === 0 ? null : file.dim) },
	}) as FixtureEmbedder;
}
