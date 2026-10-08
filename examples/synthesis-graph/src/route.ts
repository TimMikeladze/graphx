/**
 * The route planner — pure, no graphx. A synthesis graph is AND/OR: a reaction needs *all* of its
 * reactants, a molecule needs *one* way in. Plain shortest-path can't price that, so this does
 * value iteration over the snapshot `lab.ts` reads `asOf` a date:
 *
 *   cost(m)  = min(price(m), min over reactions r → m of  Σ stoich · cost(reactant) / yield(r))
 *   steps(m) = 0 if bought,   min over r → m of  1 + max steps(reactant)   (longest linear sequence)
 *
 * and compares candidates lexicographically by the chosen objective.
 */

export interface Mol {
	id: string;
	name: string;
	formula: string;
	mw: number;
	price: number | null;
	hazard: string | null;
	severity: 'severe' | 'none';
}

export interface Rxn {
	id: string;
	name: string;
	route: 'Boots' | 'BHC' | 'Flow';
	yield: number;
	conditions: string;
	ref: string;
	reactants: Array<{ id: string; stoich: number }>;
	products: Array<{ id: string; stoich: number }>;
	catalysts: string[];
}

export interface Graph {
	molecules: Mol[];
	reactions: Rxn[];
}

export type Objective = 'cost' | 'steps';

export interface PlanOpts {
	objective: Objective;
	/** Skip any reaction that consumes or is catalysed by a severe hazard. */
	avoidSevere: boolean;
}

export interface Plan {
	/** Reactions in the order you would run them. */
	steps: Rxn[];
	/** Molecules you buy, with mol needed per mol of target (before yield losses). */
	buy: Array<{ id: string; name: string; mol: number }>;
	/** Longest linear sequence. */
	lls: number;
	/** Product of the step yields. */
	overallYield: number;
	/** $ per mol of target, through the yields. */
	cost: number;
	/** MW(target) / Σ MW of everything bought, stoichiometric. */
	atomEconomy: number;
	routes: string[];
}

interface Value {
	cost: number;
	steps: number;
}

const better = (a: Value, b: Value, objective: Objective) =>
	objective === 'cost'
		? a.cost < b.cost - 1e-9 || (Math.abs(a.cost - b.cost) <= 1e-9 && a.steps < b.steps)
		: a.steps < b.steps || (a.steps === b.steps && a.cost < b.cost - 1e-9);

export function plan(g: Graph, target: string, opts: PlanOpts): Plan | null {
	const mol = new Map(g.molecules.map((m) => [m.id, m]));
	const severe = (id: string) => mol.get(id)?.severity === 'severe';
	const usable = g.reactions.filter(
		(r) =>
			r.reactants.every((x) => mol.has(x.id)) &&
			!(opts.avoidSevere && [...r.reactants.map((x) => x.id), ...r.catalysts].some(severe)),
	);

	const value = new Map<string, Value>();
	const via = new Map<string, Rxn>();
	for (const m of g.molecules) if (m.price !== null) value.set(m.id, { cost: m.price, steps: 0 });

	// Value iteration: each pass can only improve a molecule; a fixed point is reached in at most
	// one pass per reaction on an acyclic graph, and strict improvement keeps cycles from looping.
	for (let pass = 0; pass <= usable.length; pass++) {
		let changed = false;
		for (const r of usable) {
			const inputs = r.reactants.map((x) => value.get(x.id));
			if (inputs.some((v) => v === undefined)) continue;
			const cand: Value = {
				cost: r.reactants.reduce((sum, x, i) => sum + x.stoich * inputs[i]!.cost, 0) / r.yield,
				steps: 1 + Math.max(...inputs.map((v) => v!.steps)),
			};
			for (const p of r.products) {
				const cur = value.get(p.id);
				if (!cur || better(cand, cur, opts.objective)) {
					value.set(p.id, cand);
					via.set(p.id, r);
					changed = true;
				}
			}
		}
		if (!changed) break;
	}
	const best = value.get(target);
	if (!best || !via.has(target)) return null;

	// Walk the choices back from the target: post-order gives a runnable step order.
	const steps: Rxn[] = [];
	const seen = new Set<string>();
	const buy = new Map<string, number>();
	let yieldProduct = 1;
	const walk = (id: string, mol: number) => {
		const r = via.get(id);
		if (!r) {
			buy.set(id, (buy.get(id) ?? 0) + mol);
			return;
		}
		for (const x of r.reactants) walk(x.id, mol * x.stoich);
		if (!seen.has(r.id)) {
			seen.add(r.id);
			steps.push(r);
			yieldProduct *= r.yield;
		}
	};
	walk(target, 1);

	const bought = [...buy].map(([id, n]) => ({ id, name: mol.get(id)!.name, mol: n }));
	const inputMass = bought.reduce((s, b) => s + b.mol * mol.get(b.id)!.mw, 0);
	return {
		steps,
		buy: bought,
		lls: best.steps,
		overallYield: yieldProduct,
		cost: best.cost,
		atomEconomy: mol.get(target)!.mw / inputMass,
		routes: [...new Set(steps.map((s) => s.route))],
	};
}
