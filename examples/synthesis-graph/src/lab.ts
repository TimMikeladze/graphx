/**
 * The graphx half of the example. `catalog.ts` is the chemistry and `route.ts` the planner; this
 * file stores the catalog as bitemporal history and answers every question the app asks with a
 * graphx read `asOf` a date.
 *
 *   loadCatalog   bulkLoad / bulkEdges with explicit validFrom/validTo — `asOf` is a calendar date
 *   graphAt       listNodes + listEdges asOf → the snapshot the planner runs on
 *   planAt        the best route (route.ts) on that snapshot
 *   chains        shortestPath: fewest steps, and the highest-yield linear chain
 *   hazards       match: reactions that consume or are catalysed by a severe hazard
 *   changes       diff: what entered the graph between two dates
 *   versions      history: every version of one reaction
 *   whatIf        fork today, cut a supply line in the branch, re-plan
 */
import { bulkEdges, bulkLoad, diff, Graph, history, init, match, shortestPath } from 'graphx';
import { openMemoryDb } from 'graphx/local';
import { schema, type Schema } from '../schema.ts';
import { CATALOG_FROM, molecules, reactionsCatalog, START, TARGET, yearToMs } from './catalog.ts';
import {
	type Graph as Snapshot,
	type Mol,
	type Plan,
	type PlanOpts,
	plan,
	type Rxn,
} from './route.ts';

export type Lab = Graph<Schema>;

/** A fresh in-memory graph. Swap in `getDb('synthesis')` to keep it on disk. */
export async function openLab(): Promise<Lab> {
	const db = await openMemoryDb();
	await init(db);
	return new Graph(db, schema);
}

type EdgeRow = Parameters<typeof bulkEdges<Schema>>[2][number];

/**
 * The catalog as history. Each reaction version becomes a node version valid from its year until
 * the next; each edge gets one version per run of identical weight, so the 2015 flow update closes
 * the propionic-acid edge and opens the propionyl-chloride one on the same date.
 */
export async function loadCatalog(g: Lab): Promise<void> {
	await bulkLoad(g.raw, schema, [
		...molecules.map((m) => ({
			id: m.id,
			type: 'molecule' as const,
			data: {
				name: m.name,
				formula: m.formula,
				mw: m.mw,
				price: m.price,
				hazard: m.hazard,
				severity: m.severe ? 'severe' : 'none',
			},
			validFrom: yearToMs(CATALOG_FROM),
		})),
		...reactionsCatalog.flatMap((r) =>
			r.versions.map((v, i) => ({
				id: r.id,
				type: 'reaction' as const,
				data: {
					name: r.name,
					route: r.route,
					yield: v.yield,
					conditions: v.conditions,
					ref: v.ref,
				},
				validFrom: yearToMs(v.from),
				validTo: r.versions[i + 1] ? yearToMs(r.versions[i + 1]!.from) : undefined,
			})),
		),
	]);

	const edges: EdgeRow[] = [];
	for (const r of reactionsCatalog) {
		// key → [{ from, to, weight, stoich }] — one interval per version the edge is present in
		const spans = new Map<
			string,
			Array<{ from: number; to?: number; row: Omit<EdgeRow, 'validFrom' | 'validTo'> }>
		>();
		r.versions.forEach((v, i) => {
			const from = yearToMs(v.from);
			const to = r.versions[i + 1] ? yearToMs(r.versions[i + 1]!.from) : undefined;
			const rows: Array<Omit<EdgeRow, 'validFrom' | 'validTo'>> = [
				...Object.entries(v.reactants).map(([id, stoich]) => ({
					id: `reactant:${id}:${r.id}`,
					rel: 'reactant' as const,
					src: id,
					dst: r.id,
					weight: 0,
					data: { stoich },
				})),
				...Object.entries(v.products).map(([id, stoich]) => ({
					id: `product:${r.id}:${id}`,
					rel: 'product' as const,
					src: r.id,
					dst: id,
					weight: -Math.log(v.yield),
					data: { stoich },
				})),
				...v.catalysts.map((id) => ({
					id: `catalyst:${r.id}:${id}`,
					rel: 'catalyst' as const,
					src: r.id,
					dst: id,
				})),
			];
			for (const row of rows) {
				const list = spans.get(row.id!) ?? [];
				const last = list.at(-1);
				// extend the previous interval when nothing about the edge changed
				if (
					last &&
					last.to === from &&
					last.row.weight === row.weight &&
					JSON.stringify(last.row.data) === JSON.stringify(row.data)
				)
					last.to = to;
				else list.push({ from, to, row });
				spans.set(row.id!, list);
			}
		});
		for (const list of spans.values())
			for (const s of list) edges.push({ ...s.row, validFrom: s.from, validTo: s.to });
	}
	const types = new Map<string, string>([
		...molecules.map((m) => [m.id, 'molecule'] as const),
		...reactionsCatalog.map((r) => [r.id, 'reaction'] as const),
	]);
	await bulkEdges(g.raw, schema, edges, { types });
}

/** `asOf` undefined ⇒ live (today, including any what-if writes). */
export async function graphAt(g: Lab, at?: number): Promise<Snapshot> {
	const { nodes } = await g.listNodes({ asOf: at });
	const { edges } = await g.listEdges({ asOf: at, limit: 1000 });
	const molecules: Mol[] = [];
	const reactions = new Map<string, Rxn>();
	for (const n of nodes) {
		if (n.type === 'molecule') molecules.push({ id: n.id, ...n.data });
		else reactions.set(n.id, { id: n.id, ...n.data, reactants: [], products: [], catalysts: [] });
	}
	for (const e of edges) {
		const stoich = (e.data as { stoich?: number }).stoich ?? 1;
		if (e.rel === 'reactant') reactions.get(e.dst)?.reactants.push({ id: e.src, stoich });
		else if (e.rel === 'product') reactions.get(e.src)?.products.push({ id: e.dst, stoich });
		else reactions.get(e.src)?.catalysts.push(e.dst);
	}
	return { molecules, reactions: [...reactions.values()] };
}

export async function planAt(g: Lab, at: number | undefined, opts: PlanOpts): Promise<Plan | null> {
	return plan(await graphAt(g, at), TARGET, opts);
}

export interface Chains {
	/** Unweighted shortestPath isobutylbenzene → ibuprofen: hops / 2 = reactions. */
	fewestSteps: { path: string[]; steps: number } | null;
	/** Weighted on −ln(yield): the linear chain that loses the least material. */
	bestYield: { path: string[]; yield: number } | null;
}

/**
 * Two graph-native reads of "how do I get from the starting material to the target". They follow
 * one parent chain — they don't check that a reaction's *other* reactants exist, which is what the
 * AND/OR planner is for — but they are one call each and they move as the graph changes.
 */
export async function chains(g: Lab, at?: number): Promise<Chains> {
	const rels = ['reactant', 'product'];
	const hops = await shortestPath(g.raw, START, TARGET, { asOf: at, weighted: false, rels });
	const cheap = await shortestPath(g.raw, START, TARGET, { asOf: at, weighted: true, rels });
	return {
		fewestSteps: hops && { path: hops.path, steps: (hops.path.length - 1) / 2 },
		bestYield: cheap && { path: cheap.path, yield: Math.exp(-cheap.cost) },
	};
}

/** Reactions that consume, or are catalysed by, a severe hazard — two typed patterns, asOf. */
export async function hazards(g: Lab, at?: number) {
	const consumed = match(schema, g.raw)
		.node('m', 'molecule')
		.where('m', 'severity', 'severe')
		.out('reactant')
		.node('r', 'reaction');
	const catalysed = match(schema, g.raw)
		.node('r', 'reaction')
		.out('catalyst')
		.node('m', 'molecule')
		.where('m', 'severity', 'severe');
	const rows = [
		...(await (await (at === undefined ? consumed : consumed.asOf(at)).select('r', 'm')).run()),
		...(await (await (at === undefined ? catalysed : catalysed.asOf(at)).select('r', 'm')).run()),
	];
	return rows.map((row) => ({
		reaction: row.r.id,
		name: row.r.data.name,
		molecule: row.m.data.name,
		hazard: row.m.data.hazard,
	}));
}

/** What entered or left the graph between two instants — node versions from `diff`. */
export async function changes(g: Lab, from: number, to: number) {
	const d = await diff(g.raw, from, to);
	const opened = d.nodes.filter((n) => Number(n.valid_from) > from && Number(n.valid_from) <= to);
	return opened.map((n) => {
		const data = JSON.parse(String(n.data)) as { name: string; yield?: number };
		return { id: String(n.id), type: String(n.type), name: data.name, yield: data.yield };
	});
}

/** Every version of one node, oldest first, with the year it took effect. */
export async function versions(g: Lab, id: string) {
	return (await history(g.raw, id)).map((v) => ({
		from: Number(v.valid_from),
		to: Number(v.valid_to),
		data: JSON.parse(String(v.data)) as Record<string, unknown>,
	}));
}

/**
 * Branch today's graph and take molecules off the market in the branch (price → null, a new
 * version written now). The baseline never sees it; plan both and compare.
 */
export async function whatIf(g: Lab, cut: string[]): Promise<Lab> {
	const branch = await g.fork(await openMemoryDb());
	for (const id of cut) await branch.updateNode(id, { data: { price: null } });
	return branch;
}
