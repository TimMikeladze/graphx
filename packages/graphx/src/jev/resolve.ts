import { z } from 'zod';
import type { NodeType, Rel } from '../core/define-graph-schema.ts';
import type { Graph, GraphSchema } from '../core/graph.ts';
import { type Jev, type JevOptions, type JsonValue, noul, score } from './client.ts';
import { jevOf, pool } from './util.ts';

/**
 * Entity resolution with Jev: are two nodes the same entity? One `score` question whose three
 * levels are the three things you can do with a pair — leave it, send it to a curator, link it —
 * so the outcome is the nearest level and there is no threshold to fit. One `noul` per compared
 * field rides in the same request, telling the curator which field the two disagree on.
 */

export type SameEntityOutcome = 'different' | 'review' | 'same';

const OUTCOMES: readonly SameEntityOutcome[] = ['different', 'review', 'same'];

/** The three levels, lowest first. Each one is an outcome; the middle one is the curator's. */
export const SAME_ENTITY_LEVELS: [string, string, string] = [
	'They describe two different entities.',
	'They describe closely related entities that may or may not be the same one: a variant, an aspect, a namesake, or a name that could plausibly refer to either.',
	'They describe one and the same entity.',
];

/** What Jev sees of a node. */
export interface EntityView {
	type: string;
	data: Record<string, unknown>;
	body?: string | null;
}

export interface SameEntityJudgment {
	outcome: SameEntityOutcome;
	/** Probability-weighted level, 0 (different) – 2 (same). */
	score: number;
	/** Probability of the "same" level — what a written edge's `weight` carries. */
	pSame: number;
	confidence: number;
	/** Per-field agreement: the probability the two state the same value. */
	fields: Record<string, number>;
	/** The model that answered. */
	model: string;
	inputTokens: number;
}

export interface JudgeOptions {
	/** Data keys shown to Jev and compared field by field. Default: every key. */
	fields?: string[];
	/** Replace the three level descriptions; each still maps to its outcome. */
	levels?: [JsonValue, JsonValue, JsonValue];
	/** Truncate each entity's body. Default 2000. */
	maxChars?: number;
}

function view(e: EntityView, fields: string[] | undefined, maxChars: number): JsonValue {
	const data: Record<string, JsonValue> = {};
	for (const [k, v] of Object.entries(e.data)) {
		if (v === undefined || v === null || v === '') continue;
		if (fields && !fields.includes(k)) continue;
		data[k] = v as JsonValue;
	}
	return {
		type: e.type,
		data,
		...(e.body ? { text: e.body.slice(0, maxChars) } : {}),
	};
}

const present = (e: EntityView, k: string): boolean => {
	const v = e.data[k];
	return v !== undefined && v !== null && v !== '';
};

/** Judge one pair in one request. */
export async function judgeSameEntity(
	jev: Jev,
	a: EntityView,
	b: EntityView,
	opts: JudgeOptions = {},
): Promise<SameEntityJudgment> {
	const maxChars = opts.maxChars ?? 2000;
	// A field only one side states has nothing to agree on — asking would read as disagreement.
	const keys = (
		opts.fields ?? [...new Set([...Object.keys(a.data), ...Object.keys(b.data)])]
	).filter((k) => present(a, k) && present(b, k));
	const kind = a.type === b.type ? `${a.type} records` : 'records';
	const questions: Record<string, ReturnType<typeof noul> | ReturnType<typeof score>> = {
		link: score(
			`\`entity_a\` and \`entity_b\` are ${kind}, possibly from different sources. How do the entities they describe relate?`,
			opts.levels ?? SAME_ENTITY_LEVELS,
		),
	};
	for (const k of keys) {
		questions[`field:${k}`] = noul(
			`Do \`entity_a.data.${k}\` and \`entity_b.data.${k}\` state the same ${k}?`,
			{
				true: 'The same value, allowing for spelling, transliteration, casing, or formatting differences.',
				false: 'Different values.',
			},
		);
	}
	const res = await jev.ask(
		{ entity_a: view(a, opts.fields, maxChars), entity_b: view(b, opts.fields, maxChars) },
		questions,
	);
	const link = res.answers.link as {
		score: number;
		confidence: number;
		probabilities: Record<string, number>;
	};
	const fields: Record<string, number> = {};
	for (const k of keys) fields[k] = (res.answers[`field:${k}`] as { noul: number }).noul;
	return {
		outcome: OUTCOMES[Math.min(2, Math.max(0, Math.round(link.score)))] as SameEntityOutcome,
		score: link.score,
		pSame: link.probabilities['2'] ?? 0,
		confidence: link.confidence,
		fields,
		model: res.model,
		inputTokens: res.usage.input_tokens,
	};
}

/**
 * Edge data for a Jev-decided identity link. Declare it on the rel —
 * `sameAs: { from: 'x', to: 'x', data: sameEntityData }` — to keep the whole judgment; a rel
 * with a narrower data schema keeps only the keys it declares.
 */
export const sameEntityData = z.object({
	method: z.string(),
	model: z.string(),
	score: z.number(),
	confidence: z.number(),
	fields: z.record(z.string(), z.number()),
});

export interface ResolveOptions<S extends GraphSchema> extends JudgeOptions {
	/** A client, or options to build one. */
	jev?: Jev | JevOptions;
	/**
	 * Write the outcome as an edge — `same` pairs to `rels.same`, `review` pairs to
	 * `rels.review`. Pairs already joined by either rel are skipped. Omit ⇒ report only.
	 */
	rels?: { same?: Rel<S>; review?: Rel<S> };
	/** Pairs judged at once. Default 8. */
	concurrency?: number;
	/** Called after each pair is judged (and written). */
	onJudgment?: (pair: PairJudgment) => void;
}

export interface PairJudgment extends SameEntityJudgment {
	a: string;
	b: string;
	/** The edge written for this pair, if any. */
	edge?: string;
}

export interface ResolveReport {
	pairs: PairJudgment[];
	same: number;
	review: number;
	different: number;
	/** Already linked, self-pairs, duplicates, or a node that is gone. */
	skipped: number;
	written: number;
	failed: Array<{ a: string; b: string; error: string }>;
	inputTokens: number;
}

/** Judge the given node-id pairs — to audit links you already have, or pairs you blocked yourself. */
export async function judgePairs<S extends GraphSchema>(
	g: Graph<S>,
	pairs: Array<[string, string]>,
	opts: ResolveOptions<S> = {},
): Promise<ResolveReport> {
	const jev = jevOf(opts.jev);
	const report: ResolveReport = {
		pairs: [],
		same: 0,
		review: 0,
		different: 0,
		skipped: 0,
		written: 0,
		failed: [],
		inputTokens: 0,
	};
	const linkRels = [opts.rels?.same, opts.rels?.review].filter((r): r is Rel<S> => !!r);

	const seen = new Set<string>();
	const todo: Array<[string, string]> = [];
	for (const [a, b] of pairs) {
		const key = a < b ? `${a}|${b}` : `${b}|${a}`;
		if (a === b || seen.has(key)) {
			report.skipped++;
			continue;
		}
		seen.add(key);
		todo.push([a, b]);
	}

	const nodes = new Map<string, Promise<EntityView | null>>();
	const load = (id: string): Promise<EntityView | null> => {
		let p = nodes.get(id);
		if (!p) {
			p = g
				.getNodeVersion(id)
				.then((v) =>
					v ? { type: v.type, data: v.data as Record<string, unknown>, body: v.body } : null,
				);
			nodes.set(id, p);
		}
		return p;
	};
	// Writes go one at a time, in judgment order, whatever the read concurrency.
	let writes: Promise<unknown> = Promise.resolve();

	await pool(todo, opts.concurrency ?? 8, async ([a, b]) => {
		const [ea, eb] = await Promise.all([load(a), load(b)]);
		if (!ea || !eb) {
			report.skipped++;
			return;
		}
		if (linkRels.length > 0) {
			const linked = await g.neighbors(a, { rels: linkRels, direction: 'both' });
			if (linked.some((n) => n.id === b)) {
				report.skipped++;
				return;
			}
		}
		let j: SameEntityJudgment;
		try {
			j = await judgeSameEntity(jev, ea, eb, opts);
		} catch (err) {
			report.failed.push({ a, b, error: (err as Error).message });
			return;
		}
		const pair: PairJudgment = { a, b, ...j };
		report[j.outcome]++;
		report.inputTokens += j.inputTokens;
		const rel =
			j.outcome === 'same'
				? opts.rels?.same
				: j.outcome === 'review'
					? opts.rels?.review
					: undefined;
		if (rel) {
			const write = writes.then(() =>
				g.addEdge({
					rel,
					src: a,
					dst: b,
					weight: j.pSame,
					source: 'jev',
					data: {
						method: 'jev',
						model: j.model,
						score: j.score,
						confidence: j.confidence,
						fields: j.fields,
					} as never,
				}),
			);
			writes = write.catch(() => {});
			pair.edge = (await write).id;
			report.written++;
		}
		report.pairs.push(pair);
		opts.onJudgment?.(pair);
	});
	return report;
}

export interface ResolveEntitiesOptions<S extends GraphSchema> extends ResolveOptions<S> {
	/** The node type to resolve. */
	type: NodeType<S>;
	/** Nearest same-type neighbours judged per node. Default 5. */
	candidates?: number;
	/** Resolve only these nodes. Default: every live node of `type`. */
	ids?: string[];
	/** Stop after this many nodes. */
	limit?: number;
}

/**
 * Find and judge likely duplicates among the live nodes of one type. Candidates come from
 * `hybridRetrieve` over each node's own fields and body — so the graph needs an embedder, and the
 * type must be searchable (a body, or schema `embedding.text`) — and each unordered pair is judged
 * once.
 */
export async function resolveEntities<S extends GraphSchema>(
	g: Graph<S>,
	opts: ResolveEntitiesOptions<S>,
): Promise<ResolveReport> {
	const k = opts.candidates ?? 5;
	let ids = opts.ids;
	if (!ids) {
		ids = [];
		let cursor: string | undefined;
		do {
			const page = await g.listNodes({ type: opts.type, limit: 500, cursor });
			for (const n of page.nodes) ids.push(n.id);
			cursor = page.nextCursor ?? undefined;
		} while (cursor && (opts.limit === undefined || ids.length < opts.limit));
	}
	if (opts.limit !== undefined) ids = ids.slice(0, opts.limit);

	const pairs = new Map<string, [string, string]>();
	await pool(ids, opts.concurrency ?? 8, async (id) => {
		const v = await g.getNodeVersion(id);
		if (!v) return;
		const data = v.data as Record<string, unknown>;
		const text = [
			...(opts.fields ?? Object.keys(data))
				.map((f) => data[f])
				.filter((x) => typeof x === 'string' && x),
			v.body?.slice(0, 500),
		]
			.filter(Boolean)
			.join(' · ');
		if (!text) return;
		const rows = await g.hybridRetrieve({ query: text, k: k * 3, maxDepth: 0 });
		for (const r of rows.filter((r) => r.type === v.type && r.id !== id).slice(0, k)) {
			const pair: [string, string] = id < r.id ? [id, r.id] : [r.id, id];
			pairs.set(pair.join('|'), pair);
		}
	});
	// A pair both nodes found is judged once; sorted, so a run's order does not depend on timing.
	return judgePairs(
		g,
		[...pairs.keys()].sort().map((key) => pairs.get(key)!),
		opts,
	);
}
