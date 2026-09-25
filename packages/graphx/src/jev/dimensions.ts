import { persistScores } from '../core/algorithms.ts';
import type { NodeType } from '../core/define-graph-schema.ts';
import type { Graph, GraphSchema } from '../core/graph.ts';
import type { Jev, JevOptions, NoulQuestion, ScoreQuestion } from './client.ts';
import { jevOf, nodeView, pool } from './util.ts';

/**
 * A judged dimension as a graph analytic. Ask one question of every node of a type — a Score
 * along levels you describe, or a yes/no — and persist the answer as `score:<metric>`, so
 * `topNodes({ by: 'score:risk' })` ranks by it the way it ranks by pagerank. Stored 0–1: a
 * Score's level over its top level, a Noul's probability. Combine dimensions with weights in
 * code; changing a weight never re-asks anything.
 */

export interface ScoreNodesOptions<S extends GraphSchema> {
	type: NodeType<S>;
	/** The persisted name — ranked with `topNodes({ by: 'score:<metric>' })`. */
	metric: string;
	question: ScoreQuestion | NoulQuestion;
	/** Data fields Jev reads. Default: all. */
	fields?: string[];
	/** Score only these nodes. Default: every live node of `type`. */
	ids?: string[];
	jev?: Jev | JevOptions;
	/** Nodes scored at once. Default 8. */
	concurrency?: number;
	onProgress?: (done: number) => void;
}

export interface ScoreNodesReport {
	scored: number;
	failed: Array<{ id: string; error: string }>;
	inputTokens: number;
}

/** Score every node of a type and persist it. */
export async function scoreNodes<S extends GraphSchema>(
	g: Graph<S>,
	opts: ScoreNodesOptions<S>,
): Promise<ScoreNodesReport> {
	const jev = jevOf(opts.jev);
	let ids = opts.ids;
	if (!ids) {
		ids = [];
		let cursor: string | undefined;
		do {
			const page = await g.listNodes({ type: opts.type, limit: 500, cursor });
			for (const n of page.nodes) ids.push(n.id);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
	}
	const top = opts.question.type === 'score' ? opts.question.criteria.length - 1 : 1;
	const rows: Array<[string, number]> = [];
	const report: ScoreNodesReport = { scored: 0, failed: [], inputTokens: 0 };
	await pool(ids, opts.concurrency ?? 8, async (id) => {
		const v = await g.getNodeVersion(id);
		if (!v) return;
		try {
			const res = await jev.ask(nodeView(v, { fields: opts.fields }), { q: opts.question });
			const a = res.answers.q as { type: 'score'; score: number } | { type: 'noul'; noul: number };
			rows.push([id, a.type === 'score' ? a.score / top : a.noul]);
			report.inputTokens += res.usage.input_tokens;
			report.scored++;
			opts.onProgress?.(report.scored);
		} catch (err) {
			report.failed.push({ id, error: (err as Error).message });
		}
	});
	await persistScores(g.raw, opts.metric, rows);
	return report;
}
