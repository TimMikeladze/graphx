import { describe, expect, test } from 'bun:test';
import {
	assignFighterId,
	fightKeyFor,
	finishOf,
	loadState,
	mergeFights,
	slugify,
	toYaml,
	type ScrapeState,
} from '../src/vault.ts';
import { parseTitle, type FighterParsed, type FightRow } from '../src/parse.ts';

function freshState(): ScrapeState {
	return { ids: {}, used: {}, events: {}, watermark: null, fighterTitles: [], eventTitles: [] };
}

const row = (over: Partial<FightRow>): FightRow => {
	const r: FightRow = {
		result: 'win',
		opponent: 'Opponent',
		method: 'KO (punch)',
		event: 'UFC 1',
		date: '1993-11-12',
		round: 1,
		time: '0:30',
		location: 'Denver, Colorado, United States',
		note: '',
		bonuses: [],
		...over,
	};
	// The real pipeline attaches title/bonus parsing to each row; mirror it for literals.
	const title = parseTitle(r.note);
	if (title) r.title = title;
	return r;
};

const fighter = (title: string, fights: FightRow[]): FighterParsed => ({
	title,
	name: title.replace(/\s*\(fighter\)/, ''),
	lead: '',
	infobox: {},
	fights,
});

describe('slugify', () => {
	test('diacritics, punctuation, casing', () => {
		expect(slugify('Fabrício Werdum')).toBe('fabricio-werdum');
		expect(slugify("Cris 'Cyborg' Justino")).toBe('cris-cyborg-justino');
		expect(slugify('A. J. Matthews')).toBe('a-j-matthews');
	});
});

describe('assignFighterId', () => {
	test('disambiguators strip until a collision forces them back in', () => {
		const state = freshState();
		expect(assignFighterId(state, 'Anthony Smith (fighter)', 'Anthony Smith (fighter)')).toBe(
			'anthony-smith',
		);
		// A different Anthony Smith — the parenthetical keeps them apart.
		expect(assignFighterId(state, 'Anthony Smith (footballer)', 'Anthony Smith (footballer)')).toBe(
			'anthony-smith-footballer',
		);
		// Re-asking for the first is stable.
		expect(assignFighterId(state, 'Anthony Smith (fighter)', 'Anthony Smith (fighter)')).toBe(
			'anthony-smith',
		);
		// A true duplicate name gets a numeric suffix.
		expect(assignFighterId(state, 'stub:Anthony Smith', 'Anthony Smith')).toBe('anthony-smith-2');
	});
});

describe('finishOf', () => {
	test('method buckets', () => {
		expect(finishOf('KO (punch)')).toBe('ko');
		expect(finishOf('TKO (doctor stoppage)')).toBe('tko');
		expect(finishOf('Submission (guillotine choke)')).toBe('submission');
		expect(finishOf('Technical Submission (armbar)')).toBe('submission');
		expect(finishOf('Decision (split)')).toBe('decision');
		expect(finishOf('Draw (majority)')).toBe('draw');
		expect(finishOf('NC (overturned)')).toBe('nc');
		expect(finishOf('Disqualification (illegal knees)')).toBe('dq');
	});
});

describe('toYaml', () => {
	test('wikilinks must be quoted (they would parse as flow sequences)', () => {
		expect(toYaml({ winner: '[[jon-jones]]' })).toBe("winner: '[[jon-jones]]'");
	});
	test('clock times and ISO dates quote as strings', () => {
		expect(toYaml({ time: '4:29', date: '2024-11-16' })).toBe("time: '4:29'\ndate: '2024-11-16'");
	});
	test('numbers, booleans, null, arrays, nested objects', () => {
		expect(toYaml({ round: 3, ok: true, none: null })).toBe('round: 3\nok: true\nnone: null');
		expect(toYaml(['a', 'b'])).toBe('- a\n- b');
		expect(toYaml({ record: { wins: 1, losses: 2 } })).toBe('record:\n  wins: 1\n  losses: 2');
		expect(toYaml({ empty: [] })).toBe('empty: []');
	});
});

describe('mergeFights', () => {
	test('two-sided merge: one fight, winner side preferred', () => {
		const state = freshState();
		const fighters = [
			fighter('Anderson Silva', [
				row({
					result: 'win',
					opponent: 'Chael Sonnen',
					opponentArticle: 'Chael Sonnen',
					date: '2010-08-07',
				}),
			]),
			fighter('Chael Sonnen', [
				row({
					result: 'loss',
					opponent: 'Anderson Silva',
					opponentArticle: 'Anderson Silva',
					date: '2010-08-07',
				}),
			]),
		].map((p) => ({ parsed: p, id: assignFighterId(state, p.title, p.title) }));
		const { fights, stats } = mergeFights(fighters, (article, name) =>
			assignFighterId(state, article ?? `stub:${name}`, article ?? name),
		);
		expect(fights.size).toBe(1);
		expect(stats.mergedFromBothSides).toBe(1);
		const fight = [...fights.values()][0]!;
		expect(fight.result).toBe('win');
		expect(fight.winner).toBe('anderson-silva');
		expect(fight.loser).toBe('chael-sonnen');
	});

	test('one-sided loss row infers the winner from the other corner', () => {
		const state = freshState();
		const fighters = [
			fighter('A. J. Matthews', [
				row({ result: 'loss', opponent: 'Adam Figurski', date: '2009-04-23' }),
			]),
		].map((p) => ({ parsed: p, id: assignFighterId(state, p.title, p.title) }));
		const { fights } = mergeFights(fighters, (article, name) =>
			assignFighterId(state, article ?? `stub:${name}`, article ?? name),
		);
		const fight = [...fights.values()][0]!;
		expect(fight.result).toBe('win');
		expect(fight.winner).toBe('adam-figurski');
		expect(fight.loser).toBe('a-j-matthews');
	});

	test('draw and NC rows carry both corners with no winner', () => {
		const state = freshState();
		const fighters = [
			fighter('Ian McCall (fighter)', [
				row({
					result: 'draw',
					opponent: 'Demetrious Johnson',
					opponentArticle: 'Demetrious Johnson (fighter)',
					method: 'Draw (majority)',
					date: '2012-03-03',
				}),
				row({
					result: 'nc',
					opponent: 'Unknown Opponent',
					method: 'NC (overturned)',
					date: '2011-01-01',
				}),
			]),
		].map((p) => ({ parsed: p, id: assignFighterId(state, p.title, p.title) }));
		const { fights } = mergeFights(fighters, (article, name) =>
			assignFighterId(state, article ?? `stub:${name}`, article ?? name),
		);
		const draw = [...fights.values()].find((f) => f.date === '2012-03-03')!;
		expect(draw.result).toBe('draw');
		expect(draw.drew.sort()).toEqual(['demetrious-johnson', 'ian-mccall']);
		const nc = [...fights.values()].find((f) => f.date === '2011-01-01')!;
		expect(nc.result).toBe('nc');
		expect(nc.drew.length).toBe(2);
	});

	test('a title note on the loser row re-bases to a win for the winner', () => {
		const state = freshState();
		const fighters = [
			fighter('Frankie Edgar', [
				row({
					result: 'loss',
					opponent: 'Benson Henderson',
					opponentArticle: 'Benson Henderson',
					date: '2012-02-26',
					note: 'Lost the [[UFC Lightweight Championship]].',
				}),
			]),
		].map((p) => ({ parsed: p, id: assignFighterId(state, p.title, p.title) }));
		const { fights } = mergeFights(fighters, (article, name) =>
			assignFighterId(state, article ?? `stub:${name}`, article ?? name),
		);
		const fight = [...fights.values()][0]!;
		expect(fight.winner).toBe('benson-henderson');
		expect(fight.title).toEqual({ name: 'UFC Lightweight Championship', outcome: 'won' });
	});

	test('fight keys are order-independent', () => {
		expect(fightKeyFor('a', 'b', '2020-01-01')).toBe(fightKeyFor('b', 'a', '2020-01-01'));
	});
});

describe('loadState round-trip', () => {
	test('empty state on missing file', () => {
		expect(loadState('/nonexistent/path/state.json')).toEqual({
			ids: {},
			used: {},
			events: {},
			watermark: null,
			fighterTitles: [],
			eventTitles: [],
		});
	});
});
