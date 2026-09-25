import type { Graph, GraphSchema } from '../core/graph.ts';
import { choice, type Jev, type JevOptions, type JsonValue } from './client.ts';
import { jevOf, labelOf, nodeView } from './util.ts';

/**
 * Classify into a taxonomy that lives in the graph. Start at a root category and descend its
 * `rel` edges: at each category one Choice over its children — plus "none, stop here" — and the
 * `beam` most probable paths go on. The taxonomy is whatever the graph holds, so adding a
 * category needs no retraining, and `asOf` classifies against the taxonomy as it stood then.
 */

export interface ClassifyIntoOptions {
	/** The root category's node id. */
	root: string;
	/** The rel joining a category to its children. */
	rel: string;
	/** `'forward'` (default) when the rel points parent → child; `'reverse'` for child → parent. */
	direction?: 'forward' | 'reverse';
	/** What to classify. */
	text: string | JsonValue;
	/** Paths kept at each level. Default 3. */
	beam?: number;
	/** Levels below the root. Default 6. */
	maxDepth?: number;
	/** Classify against the taxonomy as of this instant. */
	asOf?: number;
	jev?: Jev | JevOptions;
}

export interface TaxonomyPath {
	/** Root first. */
	path: Array<{ id: string; label: string }>;
	/** The product of the choices along the path, including the final stop. */
	p: number;
}

const STOP = '__stop';

interface Open {
	path: Array<{ id: string; label: string }>;
	p: number;
}

/** The most probable paths down the taxonomy, best first. */
export async function classifyInto<S extends GraphSchema>(
	g: Graph<S>,
	opts: ClassifyIntoOptions,
): Promise<TaxonomyPath[]> {
	const jev = jevOf(opts.jev);
	const beam = opts.beam ?? 3;
	const root = await g.getNode(opts.root, { asOf: opts.asOf });
	if (!root) throw new Error(`classifyInto: no node '${opts.root}'`);
	let open: Open[] = [{ path: [{ id: root.id, label: labelOf(root) }], p: 1 }];
	const done: TaxonomyPath[] = [];

	for (let depth = 0; depth < (opts.maxDepth ?? 6) && open.length > 0; depth++) {
		const next: Open[] = [];
		await Promise.all(
			open.map(async (o) => {
				const here = o.path[o.path.length - 1] as { id: string; label: string };
				const children = await g.neighbors(here.id, {
					rels: [opts.rel],
					direction: opts.direction ?? 'forward',
					asOf: opts.asOf,
				});
				if (children.length === 0) return void done.push(o);
				if (children.length > 254) {
					throw new Error(
						`classifyInto: '${here.label}' has ${children.length} children; the limit is 254`,
					);
				}
				// Option keys are labels, made unique; each maps back to its child.
				const byKey = new Map<string, (typeof children)[number]>();
				for (const c of children) {
					let key = labelOf(c).slice(0, 80);
					for (let i = 2; byKey.has(key); i++) key = `${labelOf(c).slice(0, 76)} (${i})`;
					byKey.set(key, c);
				}
				const criteria: Record<string, JsonValue> = {};
				for (const [key, c] of byKey) criteria[key] = nodeView(c, { maxChars: 300 }).data;
				criteria[STOP] = `None of these fits better than "${here.label}" itself.`;
				const res = await jev.ask(
					{ item: opts.text, category: here.label },
					{
						child: choice(
							`The item belongs under "${here.label}". Which of its subcategories fits it best?`,
							criteria,
						),
					},
				);
				const probs = res.answers.child.probabilities;
				done.push({ path: o.path, p: o.p * (probs[STOP] ?? 0) });
				for (const [key, c] of byKey) {
					next.push({ path: [...o.path, { id: c.id, label: key }], p: o.p * (probs[key] ?? 0) });
				}
			}),
		);
		open = next.sort((a, b) => b.p - a.p).slice(0, beam);
	}
	done.push(...open);
	return done.sort((a, b) => b.p - a.p).slice(0, beam);
}
