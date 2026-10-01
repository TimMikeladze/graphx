import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evict } from 'graphx';
import { buildGraph } from '../src/load.ts';
import { parseFighter } from '../src/parse.ts';
import * as q from '../src/server/queries.ts';
import {
	assignFighterId,
	emitVault,
	eventIdFor,
	mergeFights,
	type EventAgg,
} from '../src/vault.ts';

/**
 * End-to-end on the checked-in fixture corpus — no network: fixtures → merged vault →
 * ingested graph → the same domain query layer the Next.js pages and /api routes call.
 * The same pipeline `scrape.ts full` runs over Wikipedia.
 */

const FIXTURES = join(import.meta.dir, 'fixtures');
const NAMESPACE = 'mma_e2e_test';
let work: string;
let graph: Awaited<ReturnType<typeof buildGraph>>['graph'];

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'mma-e2e-'));
	for (const suffix of ['', '-wal', '-shm']) rmSync(`${NAMESPACE}.db${suffix}`, { force: true });

	// fixtures → corpus (mirrors scrape.ts's buildVaultData)
	const titles = [
		'Anderson Silva',
		'Conor McGregor',
		'Cris Cyborg',
		'Donald Cerrone',
		'Fabrício Werdum',
		'Frankie Edgar',
		'Ian McCall (fighter)',
		'Nick Diaz',
	];
	const state = {
		ids: {},
		used: {},
		events: {},
		watermark: null,
		fighterTitles: [],
		eventTitles: [],
	} as ReturnType<typeof import('../src/vault.ts').loadState>;
	const parsed = titles
		.map(
			(t) => parseFighter(t, readFileSync(join(FIXTURES, `${t.replace(/ /g, '_')}.wiki`), 'utf8'))!,
		)
		.filter(Boolean);
	const fighters = parsed
		.sort((a, b) => (a.title < b.title ? -1 : 1))
		.map((p) => ({ parsed: p, id: assignFighterId(state, p.title, p.title) }));
	const { fights } = mergeFights(fighters, (article, name) =>
		assignFighterId(state, article ?? `stub:${name}`, article ?? name),
	);
	const events = new Map<string, EventAgg>();
	for (const fight of fights.values()) {
		const id = eventIdFor(state, fight.eventName);
		let agg = events.get(id);
		if (!agg) {
			agg = { id, name: fight.eventName, articles: new Set(), fightDates: [] };
			events.set(id, agg);
		}
		if (fight.date) agg.fightDates.push(fight.date);
		if (fight.eventArticle) agg.articles.add(fight.eventArticle);
	}
	const fighterFiles = fighters.map(({ parsed: p, id }) => {
		const record = { wins: 0, losses: 0, draws: 0, nc: 0 };
		for (const row of p.fights) {
			record[
				row.result === 'win'
					? 'wins'
					: row.result === 'loss'
						? 'losses'
						: row.result === 'draw'
							? 'draws'
							: 'nc'
			]++;
		}
		return {
			id,
			name: p.name,
			article: p.title,
			stub: false,
			record,
			body: `${p.name} fixture fighter.`,
		};
	});
	emitVault(fighterFiles, fights, events, { vaultDir: work });

	graph = (await buildGraph({ vaultDir: work, namespace: NAMESPACE })).graph;
});

afterAll(() => {
	evict(NAMESPACE);
	rmSync(work, { recursive: true, force: true });
	for (const suffix of ['', '-wal', '-shm']) rmSync(`${NAMESPACE}.db${suffix}`, { force: true });
});

describe('e2e: fighters and records', () => {
	test('derived stats match the career table exactly', async () => {
		const body = await q.getFighter(graph, 'cris-cyborg');
		expect(body?.derived).toMatchObject({ wins: 30, losses: 2, nc: 1, draws: 0 });
		expect(body?.record).toEqual({ wins: 30, losses: 2, draws: 0, nc: 1 });
	});

	test('record asOf time-travels to before the debut', async () => {
		const early = await q.getRecord(graph, 'cris-cyborg', '2005-05-16');
		expect(early?.fights_considered).toBe(0);
		expect(early?.record.wins).toBe(0);
		const now = await q.getRecord(graph, 'cris-cyborg');
		expect(now?.record.wins).toBe(30);
		expect(now?.fights_considered).toBe(33);
	});

	test('record asOf is monotonic in time', async () => {
		const mid = await q.getRecord(graph, 'conor-mcgregor', '2015-12-31');
		const now = await q.getRecord(graph, 'conor-mcgregor');
		expect(mid!.fights_considered).toBeLessThan(now!.fights_considered);
		expect(mid!.record.wins).toBeLessThanOrEqual(now!.record.wins);
	});

	test('unknown fighter is null (the route 404s)', async () => {
		expect(await q.getFighter(graph, 'nobody')).toBeNull();
	});
});

describe('e2e: fights, head-to-head, events', () => {
	test('fight list carries opponents and outcomes', async () => {
		const body = await q.getFighterFights(graph, 'frankie-edgar');
		expect(body!.count).toBeGreaterThan(20);
		const draw = body!.fights.find((f) => f.date === '2011-01-01');
		expect(draw).toMatchObject({ outcome: 'draw', opponent_id: 'gray-maynard' });
	});

	test('the Silva–Diaz no contest is one shared fight', async () => {
		const body = await q.getHead2Head(graph, 'anderson-silva', 'nick-diaz');
		expect(body!.met).toBe(1);
		expect(body!.fights[0]!.outcome === 'draw' || body!.fights[0]!.outcome === 'nc').toBe(true);
	});

	test('an event query lists its card', async () => {
		const body = await q.getEvent(graph, 'ufc-125');
		expect(body!.name).toBe('UFC 125');
		expect((body!.fights as unknown[]).length).toBeGreaterThan(0);
	});
});

describe('e2e: championships across time', () => {
	test('Edgar holds the lightweight belt in mid-2011', async () => {
		const champions = await q.getChampions(graph, '2011-06-01');
		const lw = champions.find((c) => c.title === 'UFC Lightweight Championship');
		expect(lw).toBeTruthy();
		expect(lw!.champion_id).toBe('frankie-edgar');
	});

	test('the belt has moved on by 2013', async () => {
		const champions = await q.getChampions(graph, '2013-01-01');
		const lw = champions.find((c) => c.title === 'UFC Lightweight Championship');
		expect(lw!.champion_id).toBe('benson-henderson');
	});

	test('reign timelines are reconstructable', async () => {
		const titles = await q.getReigns(graph);
		const lw = titles.find((t) => t.title === 'UFC Lightweight Championship');
		expect(lw).toBeDefined();
		expect(lw!.since <= '2010-04-10').toBe(true);
	});
});

describe('e2e: leaderboards', () => {
	test('knockout leaderboard ranks fighters', async () => {
		const body = await q.getLeaderboard(graph, 'ko_wins', 3);
		expect(body.top.length).toBeGreaterThan(0);
		expect(body.top[0]!.value).toBeGreaterThanOrEqual(body.top[1]!.value);
	});

	test('bad metric throws (the route 400s)', async () => {
		await expect(q.getLeaderboard(graph, 'nonsense', 3)).rejects.toThrow(/metric must be one of/);
	});
});

describe('e2e: incremental re-ingest', () => {
	test('rebuilding from an unchanged vault is a no-op', async () => {
		const { result, derived } = await buildGraph({ vaultDir: work, namespace: NAMESPACE });
		expect(result.added).toBe(0);
		expect(result.updated).toBe(0);
		expect(derived.updated).toBe(0);
		expect(existsSync(work)).toBe(true);
	});
});
