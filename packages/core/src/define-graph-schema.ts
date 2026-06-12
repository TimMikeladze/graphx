import type { z } from 'zod';

/**
 * P2 — the one Zod schema (§5, §2.7). It is the single source of validation,
 * static types, and (later) the wire contract. Pure TypeScript/zod, no DB.
 *
 * D1 (audit §0, AUTHORITATIVE — overrides §5's `number`): identity is ULID text
 * end to end, so `NodeOf.id` / `AnyNode.id` are `string`.
 */

/** A node-prop schema: any zod type whose output is an object of props. */
export type ZObj = z.ZodType<Record<string, unknown>>;

/**
 * One edge relation's definition. `props` validates edge props; `from`/`to`
 * constrain endpoint kinds (a single kind or a readonly list of them). All
 * optional — a bare `{}` is a valid, untyped, unconstrained relation.
 */
export interface EdgeDef<K extends string> {
	props?: ZObj;
	from?: K | readonly K[];
	to?: K | readonly K[];
}

/**
 * Identity at runtime (returns `s` unchanged); its job is to capture `N`/`E` as
 * precise types so the inference helpers below can read kinds, rels and prop
 * shapes back out. `E`'s `EdgeDef` is keyed on the node kinds of `N`, so
 * `from`/`to` only accept declared kinds.
 *
 * Validation contract used by P3 (§5):
 *   - `schema.nodes[kind].parse(props)` → parsed output (defaults applied);
 *     invalid props throw `ZodError`.
 *   - `schema.edges[rel].props?.parse(props)` → parsed edge props (when defined).
 *   - endpoint kind checks run against `schema.edges[rel].from`/`.to`.
 */
export function defineGraphSchema<
	N extends Record<string, ZObj>,
	E extends Record<string, EdgeDef<Extract<keyof N, string>>>,
>(s: { nodes: N; edges: E }): { nodes: N; edges: E } {
	return s;
}

type Nodes<S> = S extends { nodes: infer N } ? N : never;
type Edges<S> = S extends { edges: infer E } ? E : never;

/** Union of node-kind string literals declared in the schema. */
export type Kind<S> = Extract<keyof Nodes<S>, string>;

/** Union of edge-relation string literals declared in the schema. */
export type Rel<S> = Extract<keyof Edges<S>, string>;

/** Parsed prop shape (zod output, defaults applied) for node kind `K`. */
export type PropsOf<S, K extends Kind<S>> = Nodes<S>[K] extends z.ZodType
	? z.infer<Nodes<S>[K]>
	: never;

/** A typed node. D1: `id` is `string` (ULID text), not a number. */
export type NodeOf<S, K extends Kind<S>> = {
	id: string;
	kind: K;
	props: PropsOf<S, K>;
};

/** Discriminated union over every node kind in the schema (discriminant: `kind`). */
export type AnyNode<S> = { [K in Kind<S>]: NodeOf<S, K> }[Kind<S>];
