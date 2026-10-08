/**
 * The chemistry: every molecule and reaction the planner knows about, and *when* each became
 * known. Structures, molecular weights, routes and dates are real; yields and prices are rounded,
 * illustrative figures — enough to rank routes, not to cost a plant. `lab.ts` loads this as
 * bitemporal history.
 */

export interface MoleculeDef {
	id: string;
	name: string;
	formula: string;
	/** g/mol — real values, so atom economy is computed rather than typed in. */
	mw: number;
	/** Illustrative $/mol; `null` = not bought (an intermediate, or a catalyst you recycle). */
	price: number | null;
	hazard: string | null;
	/** Excluded by the "avoid severe hazards" filter. */
	severe: boolean;
}

const m = (
	id: string,
	name: string,
	formula: string,
	mw: number,
	price: number | null,
	hazard: string | null = null,
	severe = false,
): MoleculeDef => ({ id, name, formula, mw, price, hazard, severe });

export const TARGET = 'ibuprofen';
export const START = 'ibb';

export const molecules: MoleculeDef[] = [
	// building blocks
	m('ibb', 'Isobutylbenzene', 'C₁₀H₁₄', 134.22, 20, 'flammable'),
	m('ac2o', 'Acetic anhydride', 'C₄H₆O₃', 102.09, 5, 'corrosive'),
	m('clacoet', 'Ethyl chloroacetate', 'C₄H₇ClO₂', 122.55, 10, 'toxic'),
	m('naoet', 'Sodium ethoxide', 'C₂H₅NaO', 68.05, 6, 'corrosive'),
	m('h3o', 'Aqueous acid', 'H₃O⁺', 19.02, 0.1),
	m('nh2oh', 'Hydroxylamine', 'NH₂OH', 33.03, 15, 'explosive when dry'),
	m('h2o', 'Water', 'H₂O', 18.02, 0),
	m('h2', 'Hydrogen', 'H₂', 2.016, 0.2, 'flammable gas'),
	m('co', 'Carbon monoxide', 'CO', 28.01, 0.5, 'toxic gas', true),
	m('etcooh', 'Propionic acid', 'C₃H₆O₂', 74.08, 4, 'corrosive'),
	m('etcocl', 'Propionyl chloride', 'C₃H₅ClO', 92.52, 12, 'corrosive'),
	m('piada', 'PhI(OAc)₂', 'C₁₀H₁₁IO₄', 322.1, 120),
	m('icl', 'Iodine monochloride', 'ICl', 162.36, 40, 'corrosive'),
	m('tmof', 'Trimethyl orthoformate', 'C₄H₁₀O₃', 106.12, 8, 'flammable'),
	m('naoh', 'Sodium hydroxide', 'NaOH', 40.0, 0.5, 'corrosive'),
	// catalysts (not consumed — they matter for hazards, not for cost or atom economy)
	m('alcl3', 'Aluminium chloride', 'AlCl₃', 133.34, null, 'water-reactive'),
	m('hf', 'Hydrogen fluoride', 'HF', 20.01, null, 'acutely toxic', true),
	m('raneyni', 'Raney nickel', 'Ni', 58.69, null, 'pyrophoric', true),
	m('pd', 'Palladium catalyst', 'Pd', 106.42, null),
	m('tfoh', 'Triflic acid', 'CF₃SO₃H', 150.08, null, 'corrosive'),
	// intermediates and the target
	m('ibap', '4′-Isobutylacetophenone', 'C₁₂H₁₆O', 176.25, null),
	m('glycidic', 'Glycidic ester', 'C₁₆H₂₂O₃', 262.35, null),
	m('aldehyde', '2-Arylpropanal', 'C₁₃H₁₈O', 190.28, null),
	m('oxime', 'Aldoxime', 'C₁₃H₁₉NO', 205.3, null),
	m('nitrile', '2-Arylpropanenitrile', 'C₁₃H₁₇N', 187.28, null),
	m('alcohol', '1-Arylethanol', 'C₁₂H₁₈O', 178.27, null),
	m('propio', '4′-Isobutylpropiophenone', 'C₁₃H₁₈O', 190.28, null),
	m('ester', 'Methyl 2-arylpropanoate', 'C₁₄H₂₀O₂', 220.31, null),
	m('ibuprofen', 'Ibuprofen', 'C₁₃H₁₈O₂', 206.28, null),
];

export type Route = 'Boots' | 'BHC' | 'Flow';

/** One state of a reaction, valid from `from` (a year) until the next version. */
export interface ReactionVersion {
	from: number;
	yield: number;
	conditions: string;
	ref: string;
	reactants: Record<string, number>;
	products: Record<string, number>;
	catalysts: string[];
}

export interface ReactionDef {
	id: string;
	name: string;
	route: Route;
	versions: ReactionVersion[];
}

const BOOTS = 'Boots Pure Drug Co., ibuprofen patent (filed 1961)';
const BHC = 'BHC Co., Bishop TX plant (1992); Presidential Green Chemistry Award 1997';
const MCQUADE = 'Bogdan et al., Angew. Chem. Int. Ed. 2009, 48, 8547';
const JAMISON = 'Snead & Jamison, Angew. Chem. Int. Ed. 2015, 54, 983';

const boots = (
	id: string,
	name: string,
	y: number,
	conditions: string,
	reactants: Record<string, number>,
	product: string,
	catalysts: string[] = [],
): ReactionDef => ({
	id,
	name,
	route: 'Boots',
	versions: [
		{
			from: 1961,
			yield: y,
			conditions,
			ref: BOOTS,
			reactants,
			products: { [product]: 1 },
			catalysts,
		},
	],
});

export const reactionsCatalog: ReactionDef[] = [
	boots('B1', 'Friedel–Crafts acylation', 0.8, 'AlCl₃, CH₂Cl₂', { ibb: 1, ac2o: 1 }, 'ibap', [
		'alcl3',
	]),
	boots(
		'B2',
		'Darzens condensation',
		0.8,
		'NaOEt, EtOH',
		{ ibap: 1, clacoet: 1, naoet: 1 },
		'glycidic',
	),
	boots(
		'B3',
		'Hydrolysis / decarboxylation',
		0.85,
		'H₃O⁺, heat',
		{ glycidic: 1, h3o: 1 },
		'aldehyde',
	),
	boots('B4', 'Oxime formation', 0.9, 'NH₂OH', { aldehyde: 1, nh2oh: 1 }, 'oxime'),
	boots('B5', 'Dehydration to nitrile', 0.85, 'Ac₂O, heat', { oxime: 1 }, 'nitrile'),
	boots('B6', 'Nitrile hydrolysis', 0.85, 'H₂O, H⁺', { nitrile: 1, h2o: 2 }, 'ibuprofen'),
	{
		id: 'H1',
		name: 'HF-catalysed acylation',
		route: 'BHC',
		versions: [
			{
				from: 1992,
				yield: 0.9,
				conditions: 'anhydrous HF (recycled)',
				ref: BHC,
				reactants: { ibb: 1, ac2o: 1 },
				products: { ibap: 1 },
				catalysts: ['hf'],
			},
		],
	},
	{
		id: 'H2',
		name: 'Hydrogenation',
		route: 'BHC',
		versions: [
			{
				from: 1992,
				yield: 0.96,
				conditions: 'H₂, Raney Ni',
				ref: BHC,
				reactants: { ibap: 1, h2: 1 },
				products: { alcohol: 1 },
				catalysts: ['raneyni'],
			},
		],
	},
	{
		id: 'H3',
		name: 'Pd carbonylation',
		route: 'BHC',
		versions: [
			{
				from: 1992,
				yield: 0.95,
				conditions: 'CO, Pd, HCl',
				ref: BHC,
				reactants: { alcohol: 1, co: 1 },
				products: { ibuprofen: 1 },
				catalysts: ['pd'],
			},
		],
	},
	// The flow route arrives in 2009 and is re-versioned in 2015: same steps, new reagents, better yields.
	{
		id: 'F1',
		name: 'Friedel–Crafts acylation (flow)',
		route: 'Flow',
		versions: [
			{
				from: 2009,
				yield: 0.8,
				conditions: 'propionic acid, TfOH, 150 °C',
				ref: MCQUADE,
				reactants: { ibb: 1, etcooh: 1 },
				products: { propio: 1 },
				catalysts: ['tfoh'],
			},
			{
				from: 2015,
				yield: 0.95,
				conditions: 'propionyl chloride, AlCl₃, neat',
				ref: JAMISON,
				reactants: { ibb: 1, etcocl: 1 },
				products: { propio: 1 },
				catalysts: ['alcl3'],
			},
		],
	},
	{
		id: 'F2',
		name: '1,2-Aryl migration (flow)',
		route: 'Flow',
		versions: [
			{
				from: 2009,
				yield: 0.7,
				conditions: 'PhI(OAc)₂, TMOF, MeOH',
				ref: MCQUADE,
				reactants: { propio: 1, piada: 1, tmof: 1 },
				products: { ester: 1 },
				catalysts: [],
			},
			{
				from: 2015,
				yield: 0.92,
				conditions: 'ICl, TMOF, DMF',
				ref: JAMISON,
				reactants: { propio: 1, icl: 1, tmof: 1 },
				products: { ester: 1 },
				catalysts: [],
			},
		],
	},
	{
		id: 'F3',
		name: 'Saponification (flow)',
		route: 'Flow',
		versions: [
			{
				from: 2009,
				yield: 0.9,
				conditions: 'KOH, MeOH/H₂O',
				ref: MCQUADE,
				reactants: { ester: 1, naoh: 1 },
				products: { ibuprofen: 1 },
				catalysts: [],
			},
			{
				from: 2015,
				yield: 0.95,
				conditions: 'NaOH, 2-mercaptoethanol quench',
				ref: JAMISON,
				reactants: { ester: 1, naoh: 1 },
				products: { ibuprofen: 1 },
				catalysts: [],
			},
		],
	},
];

/** Molecules are on the shelf from here on. */
export const CATALOG_FROM = 1950;

/** The moments the answer changes — ticks on the year scrubber. */
export const EVENTS = [
	{ year: 1961, label: 'Boots route' },
	{ year: 1992, label: 'BHC process' },
	{ year: 2009, label: 'Flow (McQuade)' },
	{ year: 2015, label: 'Flow (Jamison)' },
];

export const yearToMs = (year: number) => Date.UTC(year, 0, 1);
