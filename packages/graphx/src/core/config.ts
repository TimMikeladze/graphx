import type { DbConfig } from './db.ts';
import type { Embedder } from './embedder.ts';
import type { EmbeddingMode, GraphSchema } from './graph.ts';
import type { RerankFn } from './hybrid.ts';
import type { Trigger, TriggerRunnerOptions } from './triggers.ts';

/**
 * The shape of `graphx.config.ts`'s default export — the whole contract every `graphx`
 * command (and `graphx mcp`) loads. Write it with {@link defineConfig} for inference.
 */
export interface GraphxConfig<S extends GraphSchema = GraphSchema> {
	schema: S;
	/**
	 * The namespace's embedder. Omit to run without vectors (full-text and graph reads still
	 * work; `retrieve`/`hybrid` answer 501). The width is probed from the model — there is no
	 * `dim` to configure.
	 */
	embedder?: Embedder;
	/** `'sync'` (default) embeds inside each write; `'lazy'` leaves it to `embedTrigger`. */
	embedding?: EmbeddingMode;
	/**
	 * Reranks `hybrid_search` results for `graphx serve` and `graphx mcp` — e.g. `jevRerank()`
	 * from `graphx/jev`. Omit ⇒ fused order.
	 */
	rerank?: RerankFn;
	/**
	 * Screens `retrieve` and `hybrid_search` results for `graphx serve` and `graphx mcp` — e.g.
	 * `jevGuard()` from `graphx/jev`, so an agent never reads a node body that tries to instruct
	 * it. Omit ⇒ no screening.
	 */
	guard?: RerankFn;
	/** Backend selection; `{ driver: 'postgres', connectionString }`, `{ driver: 'duckdb', ... }`
	 *  or `{ driver: 'bql', bqlUrl }`. The CLI imports that driver's subpath for you. */
	db?: DbConfig;
	/** Project DB namespace (libSQL file / PG schema / DuckDB prefix). Default `'graphx'`. */
	namespace?: string;
	/**
	 * Rules run by `graphx triggers`. Actions are functions, so they live in this config module
	 * rather than the database — which is also why the runner is a process you host, not a row.
	 */
	triggers?: Trigger<S>[];
	/** Runner tuning. `name` keys the `trigger_cursors` row and defaults to 'graphx'. */
	triggerRunner?: Partial<Omit<TriggerRunnerOptions<S>, 'triggers'>>;
}

/** Identity at runtime; captures `S` so `triggers` are typed against the schema. */
export function defineConfig<S extends GraphSchema>(cfg: GraphxConfig<S>): GraphxConfig<S> {
	return cfg;
}
