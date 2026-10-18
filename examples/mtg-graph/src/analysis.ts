import type { Card, Deck } from './schema';
import { deriveRoles } from './catalog';
import { InputError } from './search';
export function probability(population: number, successes: number, draws: number, minimum: number) {
	if (
		![population, successes, draws, minimum].every(Number.isInteger) ||
		population < 0 ||
		population > 2000 ||
		successes < 0 ||
		successes > population ||
		draws < 0 ||
		draws > population ||
		minimum < 0 ||
		minimum > 2000
	)
		throw new InputError('Require integers: 0 ≤ successes, draws ≤ population ≤ 2000; minimum ≥ 0');
	const logChoose = (n: number, k: number) => {
		if (k < 0 || k > n) return -Infinity;
		let s = 0;
		for (let i = 1; i <= Math.min(k, n - k); i++) s += Math.log(n - i + 1) - Math.log(i);
		return s;
	};
	const distribution = Array.from({ length: Math.min(successes, draws) + 1 }, (_, hits) => ({
		hits,
		probability: Math.exp(
			logChoose(successes, hits) +
				logChoose(population - successes, draws - hits) -
				logChoose(population, draws),
		),
	}));
	return {
		population,
		successes,
		draws,
		minimum,
		atLeast: Math.min(
			1,
			distribution.filter((x) => x.hits >= minimum).reduce((n, x) => n + x.probability, 0),
		),
		expected: population ? (draws * successes) / population : 0,
		distribution,
		method: 'Hypergeometric; uniform sampling without replacement',
	};
}
export interface Issue {
	code: string;
	message: string;
	cardId?: string;
}
export function validateDeck(d: Deck, catalog: Map<string, Card>): Issue[] {
	const issues: Issue[] = [];
	const main = d.entries.filter((e) => e.board === 'main');
	const active = d.entries.filter((e) => e.board !== 'maybe');
	const total = main.reduce((n, e) => n + e.quantity, 0);
	const isCommander = d.format === 'commander';
	const commander = isCommander && d.commanderId ? catalog.get(d.commanderId) : null;
	if (isCommander) {
		if (!commander) issues.push({ code: 'commander', message: 'Choose a commander' });
		else if (!commander.leadershipSkills?.commander)
			issues.push({ code: 'commander', message: `${commander.name} cannot be a commander` });
		if (total + (commander ? 1 : 0) !== 100)
			issues.push({
				code: 'size',
				message: `${total + (commander ? 1 : 0)}/100 cards including commander`,
			});
	} else if (total < 60)
		issues.push({ code: 'size', message: `${total}/60 minimum mainboard cards` });
	const side = d.entries.filter((e) => e.board === 'side').reduce((n, e) => n + e.quantity, 0);
	if (side > (isCommander ? 0 : 15))
		issues.push({
			code: 'sideboard',
			message: isCommander ? 'Commander has no sideboard' : `${side}/15 maximum sideboard cards`,
		});
	const counts = new Map<string, number>();
	for (const e of active) counts.set(e.cardId, (counts.get(e.cardId) ?? 0) + e.quantity);
	if (commander) counts.set(commander.id, (counts.get(commander.id) ?? 0) + 1);
	for (const [id, qty] of counts) {
		const c = catalog.get(id);
		if (!c) {
			issues.push({ code: 'missing', message: `Unknown card: ${id}`, cardId: id });
			continue;
		}
		const legality = c.legalities[d.format];
		if (!['Legal', 'Restricted'].includes(legality ?? ''))
			issues.push({
				code: 'legality',
				message: `${c.name}: ${legality ?? 'not legal'} in ${d.format}`,
				cardId: id,
			});
		const printedLimit = c.text.match(/(?:up to|have) (seven|nine|\d+) cards named/i);
		const words: Record<string, number> = { seven: 7, nine: 9 };
		const unlimited = /any number of cards named/i.test(c.text);
		const limit =
			legality === 'Restricted'
				? 1
				: c.supertypes.includes('Basic') || unlimited
					? Infinity
					: printedLimit
						? (words[printedLimit[1]!] ?? Number(printedLimit[1]))
						: isCommander
							? 1
							: 4;
		if (qty > limit)
			issues.push({
				code: 'copies',
				message: `${c.name}: ${qty} copies; maximum ${limit}`,
				cardId: id,
			});
		if (
			isCommander &&
			commander &&
			c.colorIdentity.some((color) => !commander.colorIdentity.includes(color))
		)
			issues.push({
				code: 'identity',
				message: `${c.name} is outside commander color identity`,
				cardId: id,
			});
	}
	return issues;
}
export function analyzeDeck(d: Deck, catalog: Map<string, Card>) {
	const curve = Array.from({ length: 8 }, (_, mv) => ({
		mv: mv === 7 ? '7+' : String(mv),
		count: 0,
	}));
	const types: Record<string, number> = {},
		roles: Record<string, number> = {},
		pips: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 },
		sources: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
	let total = 0,
		landCount = 0,
		mana = 0,
		spells = 0;
	for (const e of d.entries.filter((e) => e.board === 'main')) {
		const c = catalog.get(e.cardId);
		if (!c) continue;
		total += e.quantity;
		const land = c.faces[0]?.type.includes('Land') ?? c.types.includes('Land');
		const t = c.types.find((t) => t !== 'Tribal' && t !== 'Kindred') ?? 'Other';
		types[t] = (types[t] ?? 0) + e.quantity;
		if (land) {
			landCount += e.quantity;
			for (const color of c.colorIdentity) if (color in sources) sources[color]! += e.quantity;
		} else {
			spells += e.quantity;
			mana += c.manaValue * e.quantity;
			curve[Math.min(7, Math.floor(c.manaValue))]!.count += e.quantity;
			for (const symbol of c.faces
				.map((face) => face.manaCost)
				.join('')
				.match(/\{[^}]+\}/g) ?? [])
				for (const color of 'WUBRG') if (symbol.includes(color)) pips[color]! += e.quantity;
		}
		for (const role of deriveRoles(c)) roles[role.name] = (roles[role.name] ?? 0) + e.quantity;
	}
	return {
		total,
		landCount,
		spellCount: spells,
		averageManaValue: spells ? mana / spells : 0,
		curve,
		types,
		roles,
		pips,
		sources,
		issues: validateDeck(d, catalog),
		openingLandProbability: total >= 7 ? probability(total, landCount, 7, 2).atLeast : null,
		notes: [
			'Mana sources count land color identities, not guaranteed untapped production.',
			'Hybrid symbols contribute to each eligible color; role rules may overlap.',
		],
	};
}
