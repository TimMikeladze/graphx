import type { EdgeDef, Rel } from '../core/define-graph-schema.ts';
import type { Graph, GraphSchema } from '../core/graph.ts';
import { choice, type Jev, type JevOptions, type JsonValue } from './client.ts';
import { jevOf, labelOf, nodeView, pool } from './util.ts';

/**
 * Typed edges from untyped links. `graphx ingest` turns every `[[wikilink]]` into one generic
 * rel (`links_to`); `typeEdges` reads each link in context and picks the schema relation it
 * asserts — from the rels whose endpoints fit and whose data needs nothing — or none. A
 * confident answer is written as a second, typed edge beside the untyped one, tagged `jev`,
 * so ingest's own reconcile never touches it.
 */

export interface TypeEdgesOptions<S extends GraphSchema> {
	/** The untyped rel to read, e.g. `links_to`. */
	from: Rel<S>;
	/** Candidate rels. Default: every other rel whose endpoints fit and whose data accepts `{}`. */
	rels?: Rel<S>[];
	/** Rel descriptions shown to Jev; a rel's name is used when it has none. */
	describe?: Partial<Record<Rel<S>, string>>;
	/** Write a typed edge when the choice's confidence reaches this. Default 0.6. */
	minConfidence?: number;
	/** `false` judges and reports without writing. Default true. */
	write?: boolean;
	/** Stop after this many links. */
	limit?: number;
	/** Characters of the source's text shown around the link. Default 1200. */
	maxChars?: number;
	jev?: Jev | JevOptions;
	/** Links judged at once. Default 8. */
	concurrency?: number;
	onJudgment?: (link: TypedLink) => void;
}

export interface TypedLink {
	/** The untyped edge. */
	edge: string;
	src: string;
	dst: string;
	/** The chosen rel, or `null` for none of them. */
	rel: string | null;
	confidence: number;
	probabilities: Record<string, number>;
	/** The typed edge written, if any. */
	written?: string;
}

export interface TypeEdgesReport {
	links: TypedLink[];
	/** Written (or, with `write: false`, would have been). */
	typed: number;
	/** Jev chose none of the rels. */
	none: number;
	/** A rel was chosen below `minConfidence`: nothing written — a curator's call. */
	uncertain: number;
	/** No candidate rel fits the endpoints, a typed edge already exists, or an endpoint is gone. */
	skipped: number;
	failed: Array<{ edge: string; error: string }>;
	inputTokens: number;
}

const NONE = 'none';

/** The part of `text` around the first mention of any needle, so the link is read in context. */
function excerpt(text: string, needles: string[], max: number): string {
	if (text.length <= max) return text;
	let at = -1;
	for (const n of needles) {
		if (!n) continue;
		const i = text.toLowerCase().indexOf(n.toLowerCase());
		if (i >= 0 && (at < 0 || i < at)) at = i;
	}
	const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(max / 2));
	return text.slice(start, start + max);
}

const typeFits = (spec: string | readonly string[] | undefined, type: string): boolean =>
	spec === undefined || (typeof spec === 'string' ? spec === type : spec.includes(type));

/** Read every live `from` link and write the typed relation it asserts. */
export async function typeEdges<S extends GraphSchema>(
	g: Graph<S>,
	opts: TypeEdgesOptions<S>,
): Promise<TypeEdgesReport> {
	const jev = jevOf(opts.jev);
	const minConfidence = opts.minConfidence ?? 0.6;
	const maxChars = opts.maxChars ?? 1200;
	const edgeDefs = g.schema.edges as Record<string, EdgeDef<string>>;
	if (!(opts.from in edgeDefs)) throw new Error(`typeEdges: unknown rel '${opts.from}'`);
	const pool0 = (opts.rels ?? Object.keys(edgeDefs)).filter((r) => {
		if (r === opts.from) return false;
		const def = edgeDefs[r];
		if (!def) throw new Error(`typeEdges: unknown rel '${r}'`);
		return !def.data || def.data.safeParse({}).success;
	});

	const edges = await g.raw.execute({
		sql: `SELECT id, src, dst FROM edges WHERE rel = ? ORDER BY id${opts.limit ? ' LIMIT ?' : ''}`,
		args: opts.limit ? [opts.from, opts.limit] : [opts.from],
	});
	const report: TypeEdgesReport = {
		links: [],
		typed: 0,
		none: 0,
		uncertain: 0,
		skipped: 0,
		failed: [],
		inputTokens: 0,
	};
	let writes: Promise<unknown> = Promise.resolve();

	await pool(edges.rows, opts.concurrency ?? 8, async (row) => {
		const edge = String(row.id);
		const src = String(row.src);
		const dst = String(row.dst);
		const [a, b] = await Promise.all([g.getNodeVersion(src), g.getNodeVersion(dst)]);
		if (!a || !b) {
			report.skipped++;
			return;
		}
		const rels = pool0.filter(
			(r) => typeFits(edgeDefs[r]?.from, a.type) && typeFits(edgeDefs[r]?.to, b.type),
		);
		if (rels.length === 0) {
			report.skipped++;
			return;
		}
		const existing = await g.neighbors(src, { rels, direction: 'forward' });
		if (existing.some((n) => n.id === dst)) {
			report.skipped++;
			return;
		}
		const criteria: Record<string, JsonValue> = {};
		for (const r of rels) criteria[r] = opts.describe?.[r as Rel<S>] ?? null;
		criteria[NONE] = 'None of these: the source only mentions or points to the target.';
		const target = nodeView(b, { maxChars: 300 });
		const needles = [
			labelOf(b),
			...Object.values(target.data).filter((v) => typeof v === 'string'),
		];
		let res;
		try {
			res = await jev.ask(
				{
					source: {
						...nodeView(a, { maxChars }),
						...(a.body ? { text: excerpt(a.body, needles as string[], maxChars) } : {}),
					},
					target,
				},
				{
					rel: choice(
						'`source` links to `target`. Which relation does `source` state between them, read as "source <relation> target"?',
						criteria,
					),
				},
			);
		} catch (err) {
			report.failed.push({ edge, error: (err as Error).message });
			return;
		}
		report.inputTokens += res.usage.input_tokens;
		const ans = res.answers.rel;
		const link: TypedLink = {
			edge,
			src,
			dst,
			rel: ans.choice === NONE ? null : ans.choice,
			confidence: ans.confidence,
			probabilities: ans.probabilities,
		};
		if (link.rel === null) report.none++;
		else if (ans.confidence < minConfidence) report.uncertain++;
		else {
			report.typed++;
			if (opts.write !== false) {
				const rel = link.rel as Rel<S>;
				const write = writes.then(() =>
					g.addEdge({
						rel,
						src,
						dst,
						weight: ans.probabilities[rel] ?? ans.confidence,
						source: 'jev',
					}),
				);
				writes = write.catch(() => {});
				link.written = (await write).id;
			}
		}
		report.links.push(link);
		opts.onJudgment?.(link);
	});
	return report;
}
