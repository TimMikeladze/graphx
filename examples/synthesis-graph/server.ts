/**
 * The synthesis-graph app: one Bun process. Loads the catalog into an in-memory graphx graph,
 * serves the web app (Bun bundles `web/index.html`), and answers a few JSON routes — each one a
 * call into `src/lab.ts`.
 *
 *   bun run server.ts          # http://localhost:8930 (or the next free port)
 */
import process from 'node:process';
import index from './web/index.html';
import { EVENTS, molecules, reactionsCatalog, yearToMs } from './src/catalog.ts';
import {
	chains,
	changes,
	graphAt,
	hazards,
	type Lab,
	loadCatalog,
	openLab,
	planAt,
	versions,
	whatIf,
} from './src/lab.ts';
import type { Objective } from './src/route.ts';

export const FIRST_YEAR = 1955;
export const LAST_YEAR = 2026;
/** The scrubber's last stop is "now": a live read, which is where what-if writes land. */
const atOf = (year: number) => (year >= LAST_YEAR ? undefined : yearToMs(year));

interface Run {
	id: string;
	label: string;
	lab: Lab;
	cut: string[];
}
const runs = new Map<string, Run>();

const baseline = await openLab();
await loadCatalog(baseline);
runs.set('baseline', { id: 'baseline', label: 'Baseline', lab: baseline, cut: [] });

const run = (id: string | null) => {
	const r = runs.get(id ?? 'baseline');
	if (!r) throw new Response('unknown run', { status: 404 });
	return r;
};
const optsOf = (u: URL) => ({
	objective: (u.searchParams.get('objective') === 'steps' ? 'steps' : 'cost') as Objective,
	avoidSevere: u.searchParams.get('avoid') === '1',
});

type Req = Request & { params: Record<string, string> };
const json = (fn: (req: Req, url: URL) => Promise<unknown>) => async (req: Req) => {
	try {
		return Response.json(await fn(req, new URL(req.url)));
	} catch (e) {
		if (e instanceof Response) return e;
		return Response.json({ error: String(e) }, { status: 400 });
	}
};

// Every edge that ever existed, so the canvas can ghost chemistry that isn't known yet.
const everEdges = new Map<string, { src: string; dst: string; rel: string }>();
for (const at of [...EVENTS.map((e) => yearToMs(e.year)), undefined]) {
	for (const r of (await graphAt(baseline, at)).reactions) {
		for (const x of r.reactants)
			everEdges.set(`r:${x.id}:${r.id}`, { src: x.id, dst: r.id, rel: 'reactant' });
		for (const x of r.products)
			everEdges.set(`p:${r.id}:${x.id}`, { src: r.id, dst: x.id, rel: 'product' });
	}
}

const timelines = new Map<string, unknown>();

const routes = {
	'/': index,
	'/api/meta': {
		GET: json(async () => ({
			firstYear: FIRST_YEAR,
			lastYear: LAST_YEAR,
			events: EVENTS,
			molecules: molecules.map(({ id, name, formula, price, severe }) => ({
				id,
				name,
				formula,
				price,
				severe,
			})),
			reactions: reactionsCatalog.map(({ id, name, route }) => ({ id, name, route })),
			edges: [...everEdges.values()],
			runs: [...runs.values()].map(({ id, label, cut }) => ({ id, label, cut })),
		})),
	},
	'/api/state': {
		GET: json(async (_req, u) => {
			const r = run(u.searchParams.get('run'));
			const year = Number(u.searchParams.get('year') ?? LAST_YEAR);
			const at = atOf(year);
			const [graph, best, chain, hazard] = await Promise.all([
				graphAt(r.lab, at),
				planAt(r.lab, at, optsOf(u)),
				chains(r.lab, at),
				hazards(r.lab, at),
			]);
			const prev = [...EVENTS].reverse().find((e) => e.year <= year);
			const before = prev ? EVENTS[EVENTS.indexOf(prev) - 1] : undefined;
			const changed = prev
				? await changes(r.lab, yearToMs(before?.year ?? 1950), yearToMs(prev.year))
				: [];
			return {
				year,
				at: at ?? null,
				graph,
				plan: best,
				chains: chain,
				hazards: hazard,
				lastEvent: prev ?? null,
				changed,
			};
		}),
	},
	'/api/timeline': {
		GET: json(async (_req, u) => {
			const r = run(u.searchParams.get('run'));
			const opts = optsOf(u);
			const key = `${r.id}:${opts.objective}:${opts.avoidSevere}`;
			if (!timelines.has(key)) {
				const rows = [];
				for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
					const p = await planAt(r.lab, atOf(year), opts);
					rows.push({
						year,
						steps: p?.lls ?? null,
						yield: p ? p.overallYield * 100 : null,
						atomEconomy: p ? p.atomEconomy * 100 : null,
						cost: p?.cost ?? null,
						route: p?.routes.join(' + ') ?? null,
					});
				}
				timelines.set(key, rows);
			}
			return timelines.get(key);
		}),
	},
	'/api/versions/:id': {
		GET: json(async (req, u) => versions(run(u.searchParams.get('run')).lab, req.params.id!)),
	},
	'/api/whatif': {
		POST: json(async (req) => {
			const { cut } = (await req.json()) as { cut: string[] };
			const known = new Set(molecules.filter((m) => m.price !== null).map((m) => m.id));
			if (!Array.isArray(cut) || cut.length === 0 || !cut.every((id) => known.has(id))) {
				throw new Error('cut must list purchasable molecule ids');
			}
			const id = `whatif-${runs.size}`;
			const names = cut.map((c) => molecules.find((m) => m.id === c)!.name).join(', ');
			runs.set(id, { id, label: `No ${names}`, lab: await whatIf(baseline, cut), cut });
			return { id };
		}),
	},
};

// Never stop whatever already holds the port — walk up to the next free one.
let port = Number(process.env.PORT ?? 8930);
for (;;) {
	try {
		const server = Bun.serve({ port, routes, development: process.env.NODE_ENV !== 'production' });
		console.log(`[synthesis-graph] ${server.url}`);
		break;
	} catch (e) {
		if ((e as { code?: string }).code !== 'EADDRINUSE') throw e;
		port++;
	}
}
