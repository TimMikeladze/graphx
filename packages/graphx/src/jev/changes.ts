import type { Graph, GraphSchema } from '../core/graph.ts';
import { diff } from '../core/temporal.ts';
import { choice, type Jev, type JevOptions, noul, score } from './client.ts';
import { jevOf, nodeView, pool } from './util.ts';

/**
 * What moved between two instants, and whether it mattered. `diff` lists the versions written
 * in a window; `judgeChanges` compares each changed node's version at the start with its
 * version at the end, and asks how material the change is, whether it contradicts what was
 * there, and what kind of edit it is — one request per node.
 */

export type ChangeKind = 'correction' | 'enrichment' | 'retraction' | 'restatement';

export interface JudgedChange {
	id: string;
	type: string;
	change: 'created' | 'deleted' | 'updated';
	/** 0 cosmetic · 1 substantive · 2 structural — updates only. */
	materiality?: number;
	/** Probability the new version contradicts the old — updates only. */
	contradicts?: number;
	kind?: ChangeKind;
	/** Confidence in `kind`. */
	confidence?: number;
}

export interface JudgeChangesOptions {
	/** Window start (exclusive), epoch ms. */
	from: number;
	/** Window end (inclusive), epoch ms. */
	to: number;
	/** Only nodes of this type. */
	type?: string;
	jev?: Jev | JevOptions;
	/** Nodes judged at once. Default 8. */
	concurrency?: number;
}

export const MATERIALITY_LEVELS = [
	'Cosmetic: formatting, spelling, or wording only; the meaning is unchanged.',
	'Substantive: adds, removes, or changes facts, but the record describes the same thing in the same way.',
	'Structural: changes what the record is, what it claims at its core, or how it relates to other things.',
];

/** Every node changed in `(from, to]`, judged. Sorted most material first. */
export async function judgeChanges<S extends GraphSchema>(
	g: Graph<S>,
	opts: JudgeChangesOptions,
): Promise<JudgedChange[]> {
	const jev = jevOf(opts.jev);
	const { nodes } = await diff(g.raw, opts.from, opts.to);
	const ids = [
		...new Set(nodes.filter((r) => !opts.type || r.type === opts.type).map((r) => String(r.id))),
	].sort();
	const out: JudgedChange[] = [];
	await pool(ids, opts.concurrency ?? 8, async (id) => {
		const [before, after] = await Promise.all([
			g.getNodeVersion(id, { asOf: opts.from }),
			g.getNodeVersion(id, { asOf: opts.to }),
		]);
		const type = String((after ?? before)?.type ?? '');
		if (!before && !after) return; // created and deleted inside the window
		if (!before) return void out.push({ id, type, change: 'created' });
		if (!after) return void out.push({ id, type, change: 'deleted' });
		const res = await jev.ask(
			{ before: nodeView(before), after: nodeView(after) },
			{
				materiality: score(
					'How much does `after` change the record `before` described?',
					MATERIALITY_LEVELS,
				),
				contradicts: noul(
					'Does `after` contradict something `before` stated, rather than only adding to or rewording it?',
				),
				kind: choice('What kind of edit turned `before` into `after`?', {
					correction: 'Fixes something `before` got wrong.',
					enrichment: 'Adds information without changing what was there.',
					retraction: 'Removes or withdraws a claim `before` made.',
					restatement: 'Says the same thing differently.',
				}),
			},
		);
		out.push({
			id,
			type,
			change: 'updated',
			materiality: res.answers.materiality.score,
			contradicts: res.answers.contradicts.noul,
			kind: res.answers.kind.choice,
			confidence: res.answers.kind.confidence,
		});
	});
	const rank = (c: JudgedChange) => (c.change === 'updated' ? (c.materiality ?? 0) : 3);
	return out.sort((a, b) => rank(b) - rank(a) || (a.id < b.id ? -1 : 1));
}
