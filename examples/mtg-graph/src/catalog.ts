import { createHash } from 'node:crypto';
import type { Card } from './schema';
export type Atomic = Record<string, any>;
export const key = (type: string, name: string) =>
	`${type}:${name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')}`;
export function normalizeCard(name: string, records: Atomic[]): Card {
	const f = [...records].sort((a, b) => String(a.side ?? 'a').localeCompare(String(b.side ?? 'a')));
	const c = f[0]!;
	const union = (field: string) => [...new Set<string>(f.flatMap((x) => x[field] ?? []))];
	return {
		id: `card:${c.identifiers?.scryfallOracleId ?? createHash('sha256').update(name).digest('hex').slice(0, 32)}`,
		name,
		aliases: [],
		asciiName: c.asciiName ?? name,
		manaCost: c.manaCost ?? '',
		manaValue: c.manaValue ?? 0,
		type: c.type ?? '',
		types: union('types'),
		subtypes: union('subtypes'),
		supertypes: union('supertypes'),
		text: f.map((x) => x.text ?? '').join('\n\n'),
		colors: union('colors'),
		colorIdentity: union('colorIdentity'),
		keywords: union('keywords'),
		printings: union('printings'),
		legalities: c.legalities ?? {},
		faces: f.map((x) => ({
			name: x.faceName ?? x.name ?? name,
			manaCost: x.manaCost ?? '',
			manaValue: x.faceManaValue ?? x.manaValue ?? 0,
			type: x.type ?? '',
			text: x.text ?? '',
			...(x.power !== undefined ? { power: x.power } : {}),
			...(x.toughness !== undefined ? { toughness: x.toughness } : {}),
			...(x.loyalty !== undefined ? { loyalty: x.loyalty } : {}),
			...(x.side ? { side: x.side } : {}),
		})),
		rulings: c.rulings ?? [],
		...(c.identifiers?.scryfallId ? { scryfallId: c.identifiers.scryfallId } : {}),
		...(c.edhrecRank ? { edhrecRank: c.edhrecRank } : {}),
		...(c.leadershipSkills ? { leadershipSkills: c.leadershipSkills } : {}),
		hasAlternativeDeckLimit: c.hasAlternativeDeckLimit ?? false,
		isGameChanger: c.isGameChanger ?? false,
		layout: c.layout ?? 'normal',
	};
}
const rules: [string, RegExp][] = [
	['Card draw', /\bdraw (?:a|an|one|two|three|four|five|six|seven|x|that many|\d+) cards?\b/i],
	['Ramp', /(?:add (?:\{[^}]+\})|search your library for (?:a|up to [^.]+) [^.]*land)/i],
	[
		'Removal',
		/(?:destroy|exile) (?:target|all|each) [^.\n]*(?:creature|permanent|artifact|enchantment)|deals? [^.\n]*damage to (?:any target|target creature)/i,
	],
	['Interaction', /counter target|target [^.\n]*gains? hexproof|protection from/i],
	['Graveyard', /return [^.\n]*from your graveyard|mill [^.\n]*cards?|escape|flashback/i],
	['Tokens', /create [^.\n]*token/i],
	['Tutor', /search your library for [^.\n]*card/i],
	['Sacrifice', /sacrifice (?:a|an|another|one|two|three|x) /i],
	['Lifegain', /gain [^.\n]*life|lifelink/i],
	['Win condition', /you win the game|each opponent loses [^.\n]*life/i],
];
export function deriveRoles(card: Pick<Card, 'text'> & Partial<Pick<Card, 'types'>>) {
	return rules.flatMap(([name, re]) => {
		if (card.types?.includes('Land') && ['Ramp', 'Tutor'].includes(name)) return [];
		const m = card.text.match(re);
		return m ? [{ name, evidence: m[0], ruleVersion: 1 }] : [];
	});
}
export function imageUrl(c: Card, face = 'front') {
	const id = c.scryfallId;
	return id ? `https://cards.scryfall.io/normal/${face}/${id[0]}/${id[1]}/${id}.jpg` : null;
}
