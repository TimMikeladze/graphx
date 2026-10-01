import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	parseBonuses,
	parseDts,
	parseEvent,
	parseFighter,
	parseFightRows,
	parseTitle,
	parseProseDate,
} from '../src/parse.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

describe('parseDts', () => {
	test('year/month/day', () => {
		expect(parseDts('{{dts|2024|November|16}}')).toBe('2024-11-16');
	});
	test('format= can precede the date', () => {
		expect(parseDts('{{dts|format=mdy|2020|February|8}}')).toBe('2020-02-08');
	});
	test('format= can follow the date', () => {
		expect(parseDts('{{dts|2022|November|12|format=mdy}}')).toBe('2022-11-12');
	});
	test('ISO single-argument form', () => {
		expect(parseDts('{{dts|2005-05-17}}')).toBe('2005-05-17');
	});
	test('non-dts cell', () => {
		expect(parseDts('2020-10-31')).toBeNull();
	});
});

describe('parseTitle', () => {
	test('won / defended / lost / for', () => {
		expect(parseTitle('Won the [[UFC Heavyweight Championship]].')).toEqual({
			name: 'UFC Heavyweight Championship',
			outcome: 'won',
		});
		expect(parseTitle('Defended the [[UFC Heavyweight Championship]].')).toMatchObject({
			outcome: 'defended',
		});
		expect(parseTitle("Lost the [[UFC Women's Featherweight Championship]].")).toMatchObject({
			outcome: 'lost',
		});
		expect(
			parseTitle(
				"For the [[List of Strikeforce champions#Women's Featherweight Championship|Strikeforce Women's Featherweight Championship]].",
			),
		).toMatchObject({ name: "Strikeforce Women's Featherweight Championship", outcome: 'for' });
	});
	test('vacant and interim phrasings', () => {
		expect(parseTitle('Won the vacant [[UFC Heavyweight Championship]].')).toMatchObject({
			outcome: 'won',
		});
		expect(parseTitle('Retained the [[UFC Lightweight Championship]].')).toMatchObject({
			outcome: 'defended',
		});
	});
	test('tournaments and non-title notes stay out', () => {
		expect(parseTitle('2017 Rizin Bantamweight Grand Prix Quarterfinal.')).toBeUndefined();
		expect(parseTitle('Featherweight debut.')).toBeUndefined();
	});
});

describe('parseBonuses', () => {
	test('night bonuses normalize', () => {
		expect(parseBonuses('Fight of the Night.')).toEqual(['fight-of-the-night']);
		expect(parseBonuses('Defended the belt. Performance of the Night.')).toEqual([
			'performance-of-the-night',
		]);
		expect(parseBonuses('Nothing here.')).toEqual([]);
	});
});

describe('parseFightRows — fixture corpora', () => {
	test('career totals match the tables exactly', () => {
		const expected: Array<[string, number, Record<string, number>]> = [
			['Donald_Cerrone.wiki', 55, { win: 36, loss: 17, nc: 2 }],
			['Cris_Cyborg.wiki', 33, { win: 30, loss: 2, nc: 1 }],
			['Conor_McGregor.wiki', 29, { win: 22, loss: 7 }],
			['Nick_Diaz.wiki', 38, { win: 26, loss: 10, nc: 2 }],
			['Fabrício_Werdum.wiki', 35, { win: 24, loss: 9, draw: 1, nc: 1 }],
			['Frankie_Edgar.wiki', 36, { win: 24, loss: 11, draw: 1 }],
			['Ian_McCall_(fighter).wiki', 21, { win: 13, loss: 7, draw: 1 }],
		];
		for (const [name, total, byResult] of expected) {
			const rows = parseFightRows(fixture(name));
			const counts = rows.reduce<Record<string, number>>((a, r) => {
				a[r.result] = (a[r.result] ?? 0) + 1;
				return a;
			}, {});
			expect(rows.length, name).toBe(total);
			expect(counts, name).toEqual(byResult);
		}
	});

	test('row anatomy: result, corners, method, event, round/time, location, title', () => {
		const rows = parseFightRows(fixture('Anderson_Silva.wiki'));
		const hall = rows.find((r) => r.opponent === 'Uriah Hall')!;
		expect(hall).toMatchObject({
			result: 'loss',
			method: 'TKO (punches)',
			event: 'UFC Fight Night: Hall vs. Silva',
			eventArticle: 'UFC Fight Night: Hall vs. Silva',
			date: '2020-10-31',
			round: 4,
			time: '1:24',
			location: 'Las Vegas, Nevada, United States',
		});
	});

	test('plain-text opponents and events (no article behind them)', () => {
		const cyborg = parseFightRows(fixture('Cris_Cyborg.wiki'));
		const paes = cyborg.find((r) => r.opponent === 'Erica Paes')!;
		expect(paes.opponentArticle).toBeUndefined();
		expect(paes.event).toBe('Show Fight 2');
		expect(paes.eventArticle).toBeUndefined();
		expect(paes.date).toBe('2005-05-17');
	});

	test('section-anchored event links use the label, not the year page', () => {
		const mcCall = parseFightRows(fixture('Ian_McCall_(fighter).wiki'));
		const rizin = mcCall.find((r) => r.event === 'Rizin 10')!;
		expect(rizin.eventArticle).toBeUndefined(); // target was `2018 in Rizin…#Rizin 10`
	});

	test('the no-contest row against Diaz carries the overturned note', () => {
		const silva = parseFightRows(fixture('Anderson_Silva.wiki'));
		const nc = silva.find((r) => r.opponent === 'Nick Diaz')!;
		expect(nc.result).toBe('nc');
		expect(nc.method).toBe('NC (overturned by NSAC)');
	});

	test('only the FIRST record table parses — amateur tables stay out', () => {
		const proThenAmateur = [
			'{{MMA record start}}',
			'|-',
			'|{{yes2}}Win',
			'|align=center|1–0',
			'|[[Somebody]]',
			'|KO (punch)',
			'|[[UFC 1]]',
			'|{{dts|1993|November|12}}',
			'|align=center|1',
			'|align=center|0:30',
			'|[[Denver, Colorado]], United States',
			'|',
			'{{MMA record end}}',
			'===Amateur===',
			'{{MMA record start}}',
			'|-',
			'|{{yes2}}Win',
			'|align=center|1–0',
			'|[[Amateur Opponent]]',
			'|Decision (unanimous)',
			'|[[Local Show 1]]',
			'|{{dts|1990|January|1}}',
			'|align=center|2',
			'|align=center|3:00',
			'|[[Nowhere]]',
			'|',
			'{{MMA record end}}',
		].join('\n');
		const rows = parseFightRows(proThenAmateur);
		expect(rows.length).toBe(1);
		expect(rows[0]!.opponent).toBe('Somebody');
	});

	test('disambiguation pages parse to null', () => {
		expect(parseFighter('Ian McCall', fixture('Ian_McCall.wiki'))).toBeNull();
	});
});

describe('parseFighter bio', () => {
	test('lead and infobox', () => {
		const Conor = parseFighter('Conor McGregor', fixture('Conor_McGregor.wiki'))!;
		expect(Conor.name).toBe('Conor McGregor');
		expect(Conor.lead).toStartWith('Conor Anthony McGregor');
		expect(Conor.infobox.division).toBe('Featherweight');
		expect(Conor.infobox.height).toBe('5 ft 8 in');
		expect(Conor.infobox.weight).toBe('170 lb');
		expect(Conor.infobox.reach).toBe('74 in');
	});

	test('fighter-name disambiguators are stripped', () => {
		const werdum = parseFighter('Fabrício Werdum', fixture('Fabrício_Werdum.wiki'))!;
		expect(werdum.name).toBe('Fabrício Werdum');
		const mcCall = parseFighter('Ian McCall (fighter)', fixture('Ian_McCall_(fighter).wiki'))!;
		expect(mcCall.name).toBe('Ian McCall');
	});
});

describe('parseEvent', () => {
	test('UFC 100 infobox', () => {
		const e = parseEvent('UFC 100', fixture('UFC_100.wiki'))!;
		expect(e).toMatchObject({
			name: 'UFC 100',
			promotion: 'Ultimate Fighting Championship',
			date: '2009-07-11',
			venue: 'Mandalay Bay Events Center',
			city: 'Las Vegas, Nevada',
			attendance: 10_871,
			gate_usd: 5_101_740,
		});
	});
	test('prose dates in either order', () => {
		expect(parseProseDate('July 11, 2009')).toBe('2009-07-11');
		expect(parseProseDate('11 July 2009')).toBe('2009-07-11');
	});
});
