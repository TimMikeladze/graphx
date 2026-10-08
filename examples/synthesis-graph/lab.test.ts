import { beforeAll, expect, test } from 'bun:test';
import { yearToMs } from './src/catalog.ts';
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

let g: Lab;
beforeAll(async () => {
	g = await openLab();
	await loadCatalog(g);
});

const cheapest = { objective: 'cost' as const, avoidSevere: false };
const safe = { objective: 'cost' as const, avoidSevere: true };
const at = yearToMs;

test('nothing reaches ibuprofen before the Boots patent', async () => {
	expect(await planAt(g, at(1955), cheapest)).toBeNull();
	expect((await chains(g, at(1955))).fewestSteps).toBeNull();
});

test('the best route moves from Boots to BHC in 1992, with the textbook atom economies', async () => {
	const boots = (await planAt(g, at(1970), cheapest))!;
	expect(boots.routes).toEqual(['Boots']);
	expect(boots.lls).toBe(6);
	expect(boots.atomEconomy).toBeCloseTo(0.401, 2);

	const bhc = (await planAt(g, at(1995), cheapest))!;
	expect(bhc.steps.map((s) => s.id)).toEqual(['H1', 'H2', 'H3']);
	expect(bhc.atomEconomy).toBeCloseTo(0.775, 2);
	expect(bhc.cost).toBeLessThan(boots.cost);
});

test('avoiding HF/CO/Raney Ni, the flow route only becomes the answer with its 2015 version', async () => {
	expect((await planAt(g, at(2010), safe))!.routes).toEqual(['Boots']); // 2009 flow exists but loses
	expect((await planAt(g, at(2016), safe))!.routes).toEqual(['Flow']);
});

test('a reaction keeps its history: F2 swaps PhI(OAc)₂ for ICl in 2015', async () => {
	const v = await versions(g, 'F2');
	expect(v.map((x) => [new Date(x.from).getUTCFullYear(), x.data.yield])).toEqual([
		[2009, 0.7],
		[2015, 0.92],
	]);
	const reactantsOf = async (year: number) =>
		(await graphAt(g, at(year))).reactions
			.find((r) => r.id === 'F2')!
			.reactants.map((r) => r.id)
			.sort();
	expect(await reactantsOf(2010)).toEqual(['piada', 'propio', 'tmof']);
	expect(await reactantsOf(2016)).toEqual(['icl', 'propio', 'tmof']);
	expect((await changes(g, at(2009), at(2015))).map((c) => c.id).sort()).toEqual([
		'F1',
		'F2',
		'F3',
	]);
});

test('shortestPath and match read the graph as of the date', async () => {
	expect((await chains(g, at(1970))).fewestSteps!.steps).toBe(6);
	expect((await chains(g, at(1995))).fewestSteps!.steps).toBe(3);
	expect(await hazards(g, at(1980))).toEqual([]);
	expect((await hazards(g, at(1995))).map((h) => h.reaction).sort()).toEqual(['H1', 'H2', 'H3']);
});

test('a supply cut lives only in its fork, and only from today', async () => {
	const branch = await whatIf(g, ['ac2o']);
	expect((await planAt(branch, undefined, cheapest))!.routes).toEqual(['Flow']);
	expect((await planAt(g, undefined, cheapest))!.routes).toEqual(['BHC']);
	// the branch's past is untouched: in 1995 acetic anhydride was still on the shelf
	expect((await planAt(branch, at(1995), cheapest))!.routes).toEqual(['BHC']);
});
