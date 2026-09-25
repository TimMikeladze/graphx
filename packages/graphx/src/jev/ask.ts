import { topNodes, type TopNodesMetric } from '../core/algorithms.ts';
import type { AnyNode, NodeType } from '../core/define-graph-schema.ts';
import type { Graph, GraphSchema } from '../core/graph.ts';
import { choice, type Jev, type JevOptions, type JsonValue } from './client.ts';
import { jevOf } from './util.ts';

/**
 * A question in plain words to a typed graph call. One request picks the operation and — asked
 * speculatively, all at once — the node type and ranking metric it would need, from closed sets
 * the schema defines. So the plan is always a valid call, or it says it is unsure; it cannot be
 * a malformed one.
 */

export type QueryOp = 'search' | 'list' | 'top';

export interface QueryPlan<S extends GraphSchema> {
	op: QueryOp;
	/** `null` for any type. */
	type: NodeType<S> | null;
	/** The ranking metric, for `top`. */
	metric: TopNodesMetric | null;
	/** Confidence in `op`. */
	confidence: number;
	/** Confidence in `type`. */
	typeConfidence: number;
}

export interface PlanOptions {
	/** Scores written with `persistScores`/`scoreNodes` that `top` may rank by: name → meaning. */
	metrics?: Record<string, string>;
	/** Node type descriptions; a type's zod `.describe()` text is used when absent. */
	describe?: Record<string, string>;
	jev?: Jev | JevOptions;
}

const ANY = '__any';

/** Plan a question as a graph call. */
export async function planQuery<S extends GraphSchema>(
	schema: S,
	question: string,
	opts: PlanOptions = {},
): Promise<QueryPlan<S>> {
	const jev = jevOf(opts.jev);
	const nodes = schema.nodes as unknown as Record<string, { description?: string }>;
	const metrics: Record<string, JsonValue> = {
		pagerank: 'Importance or influence: the records most referred to by other important records.',
		degree: 'Connectedness: the records with the most links.',
	};
	for (const [name, meaning] of Object.entries(opts.metrics ?? {}))
		metrics[`score:${name}`] = meaning;
	const res = await jev.ask(
		{ question },
		{
			op: choice('What does the question ask the graph to do?', {
				search: 'Find the records about a topic, event, or description.',
				list: 'List the records of one kind, with no topic to match.',
				top: 'Rank records by a measure — the most important, connected, or highest-scoring.',
			}),
			type: choice('Which kind of record is the question about?', {
				...Object.fromEntries(
					Object.keys(nodes).map((t) => [t, opts.describe?.[t] ?? nodes[t]?.description ?? null]),
				),
				[ANY]: 'Any kind, or several.',
			}),
			metric: choice('If the question ranks records, by which measure?', metrics),
		},
	);
	const { op, type, metric } = res.answers;
	return {
		op: op.choice as QueryOp,
		type: type.choice === ANY ? null : (type.choice as NodeType<S>),
		metric: op.choice === 'top' ? (metric.choice as TopNodesMetric) : null,
		confidence: op.confidence,
		typeConfidence: type.confidence,
	};
}

export interface AskResult<S extends GraphSchema> {
	plan: QueryPlan<S>;
	/** `null` when the plan's confidence was below `minConfidence` — nothing was run. */
	rows: AnyNode<S>[] | null;
}

/** Plan a question and run it. `search` needs the graph's embedder. */
export async function askGraph<S extends GraphSchema>(
	g: Graph<S>,
	question: string,
	opts: PlanOptions & { limit?: number; minConfidence?: number } = {},
): Promise<AskResult<S>> {
	const plan = await planQuery(g.schema, question, opts);
	if (plan.confidence < (opts.minConfidence ?? 0.4)) return { plan, rows: null };
	const limit = opts.limit ?? 10;
	const type = plan.type ?? undefined;
	if (plan.op === 'search') {
		const rows = await g.hybridRetrieve({ query: question, k: limit * 3, maxDepth: 0 });
		return {
			plan,
			rows: rows
				.filter((r) => !type || r.type === type)
				.slice(0, limit)
				.map((r) => ({ id: r.id, type: r.type, data: r.data }) as AnyNode<S>),
		};
	}
	if (plan.op === 'list') {
		return { plan, rows: (await g.listNodes({ type, limit })).nodes };
	}
	const top = await topNodes(g.raw, { by: plan.metric ?? 'pagerank', type, limit });
	const rows = await Promise.all(top.map((t) => g.getNode(t.id)));
	return { plan, rows: rows.filter((r) => r !== null) as AnyNode<S>[] };
}
