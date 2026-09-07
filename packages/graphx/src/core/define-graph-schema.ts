import type { z } from 'zod';
import type { EmbeddingPolicy } from './embedder.ts';

/**
 * P2 — the one Zod schema (§5, §2.7). It is the single source of validation,
 * static types, and (later) the wire contract. Pure TypeScript/zod, no DB.
 *
 * D1 (audit §0, AUTHORITATIVE — overrides §5's `number`): identity is ULID text
 * end to end, so `NodeOf.id` / `AnyNode.id` are `string`.
 */

/** A node-prop schema: any zod type whose output is an object of data. */
export type ZObj = z.ZodType<Record<string, unknown>>;

/**
 * One edge relation's definition. `data` validates edge data; `from`/`to`
 * constrain endpoint types (a single type or a readonly list of them). All
 * optional — a bare `{}` is a valid, untyped, unconstrained relation.
 *
 * `single: true` marks the rel single-valued (cardinality 1 per source, §19.5): each
 * `addEdge` closes any existing live `(src, rel)` edge in the same write, and
 * `materializeConstraints` adds a partial unique index hard-guaranteeing it.
 */
export interface EdgeDef<K extends string> {
	data?: ZObj;
	from?: K | readonly K[];
	to?: K | readonly K[];
	single?: boolean;
}

/**
 * Identity at runtime (returns `s` unchanged); its job is to capture `N`/`E` as
 * precise types so the inference helpers below can read types, rels and prop
 * shapes back out. `E`'s `EdgeDef` is keyed on the node types of `N`, so
 * `from`/`to` only accept declared types.
 *
 * Validation contract used by P3 (§5):
 *   - `schema.nodes[type].parse(data)` → parsed output (defaults applied);
 *     invalid data throw `ZodError`.
 *   - `schema.edges[rel].data?.parse(data)` → parsed edge data (when defined).
 *   - endpoint type checks run against `schema.edges[rel].from`/`.to`.
 */
export function defineGraphSchema<
	N extends Record<string, ZObj>,
	E extends Record<string, EdgeDef<Extract<keyof N, string>>>,
	P extends EmbeddingPoliciesFor<N> = Record<never, never>,
>(s: { nodes: N; edges: E; embedding?: P }): { nodes: N; edges: E; embedding: P | undefined } {
	return { nodes: s.nodes, edges: s.edges, embedding: s.embedding };
}

/**
 * Per-type embedding policy, keyed on the node types of `N` and typed against each type's parsed
 * data. Omit a type to embed its `body` as one vector; declare `text` to embed something else
 * (a data-only type has no body), and `chunk` to split long inputs into several vectors.
 */
export type EmbeddingPoliciesFor<N extends Record<string, ZObj>> = {
	[K in keyof N]?: EmbeddingPolicy<N[K] extends z.ZodType ? z.infer<N[K]> : never>;
};

type Nodes<S> = S extends { nodes: infer N } ? N : never;
type Edges<S> = S extends { edges: infer E } ? E : never;

/** Union of node-type string literals declared in the schema. */
export type NodeType<S> = Extract<keyof Nodes<S>, string>;

/** Union of edge-relation string literals declared in the schema. */
export type Rel<S> = Extract<keyof Edges<S>, string>;

/** Parsed prop shape (zod output, defaults applied) for node type `K`. */
export type DataOf<S, K extends NodeType<S>> = Nodes<S>[K] extends z.ZodType
	? z.infer<Nodes<S>[K]>
	: never;

/** A typed node. D1: `id` is `string` (ULID text), not a number. */
export type NodeOf<S, K extends NodeType<S>> = {
	id: string;
	type: K;
	data: DataOf<S, K>;
};

/** Discriminated union over every node type in the schema (discriminant: `type`). */
export type AnyNode<S> = { [K in NodeType<S>]: NodeOf<S, K> }[NodeType<S>];
