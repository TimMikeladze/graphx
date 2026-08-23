/**
 * The one tokenizer, shared by the writer that builds the index and the reader that parses
 * a query.
 *
 * Sharing is the entire design constraint. An index built with one tokenization and queried
 * with another returns nothing at all — not fewer results, none — and no test outside this
 * module's own would catch it, because both halves would look individually reasonable.
 *
 * v1 does not stem. libSQL's `fts5(body, …)` uses the default `unicode61` tokenizer, which
 * does not stem either (measured: `"run"` matches no document containing `running runs`),
 * and libSQL is the backend the committed golden rankings were measured against. Matching it
 * keeps ranking parity honest. Postgres does stem, so its lexical recall is genuinely higher
 * on inflected queries; that difference is recorded in docs/DUCKDB_SUPPORT.md rather than
 * papered over. Adding a stemmer later is additive — the index is rebuilt on every commit,
 * so writer and reader change together and there is nothing to migrate.
 */

/**
 * Term boundary: any run of characters that is neither a letter nor a number, Unicode-aware.
 * Matches `unicode61`'s default class, which treats everything outside those two categories
 * as a separator.
 */
export const TOKEN_SPLIT: RegExp = /[^\p{L}\p{N}]+/u;

/** Lowercase terms in document order. Duplicates are kept — term frequency is the caller's. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(TOKEN_SPLIT)
		.filter((t: string) => t.length > 0);
}
