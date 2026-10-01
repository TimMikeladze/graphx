/**
 * The domain layer on top of the graph: fighters, records across time, head-to-heads, events,
 * leaderboards and championship timelines.
 *
 * Plain async functions over the `Graph` — no HTTP anywhere. The Next.js pages call them
 * in-process (server components); the `app/api` route handlers expose the same functions over
 * HTTP with identical response shapes. The only heavyweight walk — championship reconstruction
 * over all title fights — is computed once and cached per process.
 */
import type { Graph } from 'graphx';
import { aggregate, fightsOf, type DerivedStats } from '../load.ts';
import type { MmaSchema } from '../schema.ts';

type MmaGraph = Graph<MmaSchema>;

interface FightData {
	id: string;
	date: string;
	result?: string;
	method?: string;
	finish?: string;
	round?: number;
	time?: string;
	event_name?: string;
	location?: string;
	winner_id?: string;
	loser_id?: string;
	drew_ids?: string[];
	title?: { name: string; outcome: string };
	bonuses?: string[];
}

export interface FightOutcomeView {
	id: string;
	date?: string;
	outcome: string;
	method?: string;
	finish?: string;
	round: number | null;
	time: string | null;
	event?: string;
	location?: string;
	opponent_id?: string;
	opponent_name?: string;
	title: { name: string; outcome: string } | null;
	bonuses: string[];
}

function fightView(o: { fight: Record<string, unknown>; outcome: string }): FightOutcomeView {
	const f = o.fight as unknown as FightData;
	return {
		id: f.id,
		date: f.date,
		outcome: o.outcome,
		method: f.method,
		finish: f.finish,
		round: f.round ?? null,
		time: f.time ?? null,
		event: f.event_name,
		location: f.location,
		opponent_id: undefined,
		title: f.title ?? null,
		bonuses: f.bonuses ?? [],
	};
}

// --- fighter-by-slug cache -------------------------------------------------------------------------

async function fighterBySlug(graph: MmaGraph, slug: string) {
	// Ingest nodes carry `uri = ingest:wikipedia-mma:id:<slug>`; listing by type and matching
	// `data.id` is the simple path, but walking pages for every request is wasteful — the
	// fighter-by-slug cache below avoids it.
	const cached = fighterCache.get(graph)?.get(slug);
	if (cached) return cached;
	let cursor: string | null = null;
	do {
		const page = await graph.listNodes({
			type: 'fighter',
			limit: 2000,
			cursor: cursor ?? undefined,
		});
		for (const n of page.nodes) {
			const data = n.data as { id: string };
			let map = fighterCache.get(graph);
			if (!map) {
				map = new Map();
				fighterCache.set(graph, map);
			}
			map.set(data.id, n);
		}
		cursor = page.nextCursor;
	} while (cursor);
	return fighterCache.get(graph)?.get(slug);
}

const fighterCache = new WeakMap<
	MmaGraph,
	Map<string, { id: string; data: Record<string, unknown> }>
>();

/** Load (once per graph) every fighter into the slug cache — cheap and makes name joins free. */
async function warmFighters(graph: MmaGraph) {
	if (fighterCache.get(graph)?.size) return;
	await fighterBySlug(graph, '\u0000warm\u0000').catch(() => undefined);
}

function fighterNameOf(
	map: Map<string, { id: string; data: Record<string, unknown> }> | undefined,
	slug: string | null | undefined,
): string | undefined {
	if (!slug) return undefined;
	return (map?.get(slug)?.data as { name?: string } | undefined)?.name;
}

// --- championship timeline ---------------------------------------------------------------------------

interface ChampionEntry {
	title: string;
	champion_id: string | null;
	/** When this reign started (the title-fight date the champion won it). */
	since: string;
}

class TitleCache {
	private timeline: ChampionEntry[] | null = null;

	forget() {
		this.timeline = null;
	}

	/** Every reign ever, chronological per title — the raw material for point-in-time reads. */
	async reigns(graph: MmaGraph): Promise<ChampionEntry[]> {
		if (!this.timeline) this.timeline = await computeReigns(graph);
		return this.timeline;
	}

	/** Who held each title at `asOf` (or now): the last reign that had started by then. */
	async champions(graph: MmaGraph, asOf?: string): Promise<Map<string, ChampionEntry>> {
		const reigns = await this.reigns(graph);
		const byTitle = new Map<string, ChampionEntry>();
		for (const e of reigns) {
			if (asOf && e.since > asOf) continue;
			const prev = byTitle.get(e.title);
			if (!prev || e.since >= prev.since) byTitle.set(e.title, e);
		}
		return byTitle;
	}
}

const titleCache = new TitleCache();

/**
 * Championship reigns from title fights: after every non-draw title fight the winner holds the
 * belt, so a change of winner starts a new reign. Vacated/stripped titles are invisible to fight
 * data — the limitation is documented in the README.
 */
async function computeReigns(graph: MmaGraph): Promise<ChampionEntry[]> {
	const titleFights: Array<{ date: string; title: string; winner_id?: string }> = [];
	let cursor: string | null = null;
	do {
		const page = await graph.listNodes({ type: 'fight', limit: 2000, cursor: cursor ?? undefined });
		for (const n of page.nodes) {
			const f = n.data as unknown as FightData;
			// Only dated, decided title fights contribute to a reign.
			if (f.title && f.winner_id && f.date) {
				titleFights.push({ date: f.date, title: f.title.name, winner_id: f.winner_id });
			}
		}
		cursor = page.nextCursor;
	} while (cursor);
	titleFights.sort((a, b) => a.date.localeCompare(b.date));

	const reigns: ChampionEntry[] = [];
	const current = new Map<string, string>();
	for (const tf of titleFights) {
		if (current.get(tf.title) === tf.winner_id) continue; // a defense
		current.set(tf.title, tf.winner_id!);
		reigns.push({ title: tf.title, champion_id: tf.winner_id!, since: tf.date });
	}
	return reigns.sort((a, b) => a.title.localeCompare(b.title) || a.since.localeCompare(b.since));
}

// --- the queries ---------------------------------------------------------------------------------------

export interface RecentFight {
	id: string;
	date: string;
	method?: string;
	finish?: string;
	round: number | null;
	time: string | null;
	event?: string;
	winner_id: string | null;
	loser_id: string | null;
	winner_name?: string;
	loser_name?: string;
	title: { name: string; outcome: string } | null;
}

export interface StatsResult {
	fighters: number;
	events: number;
	recent: RecentFight[];
}

/** Corpus counts + the newest fights, for the dashboard. */
export async function getStats(graph: MmaGraph, recent = 12): Promise<StatsResult> {
	await warmFighters(graph);
	const fighters = fighterCache.get(graph)!;
	const limit = Math.min(recent, 50);
	const fights = await recentFights(graph);
	let events = 0;
	let cursor: string | null = null;
	do {
		const page = await graph.listNodes({ type: 'event', limit: 2000, cursor: cursor ?? undefined });
		events += page.nodes.length;
		cursor = page.nextCursor;
	} while (cursor);
	return { fighters: fighters.size, events, recent: fights.slice(0, limit) };
}

/** The 50 newest dated fights with fighter names joined in (60s cache — the dashboard polls it). */
async function recentFights(graph: MmaGraph): Promise<RecentFight[]> {
	if (!recentCache || Date.now() - recentCache.at > 60_000) {
		await warmFighters(graph);
		const fighters = fighterCache.get(graph)!;
		const dated: RecentFight[] = [];
		let cursor: string | null = null;
		do {
			const page = await graph.listNodes({
				type: 'fight',
				limit: 2000,
				cursor: cursor ?? undefined,
			});
			for (const n of page.nodes) {
				const f = n.data as unknown as FightData;
				if (!f.date) continue;
				dated.push({
					id: f.id,
					date: f.date,
					method: f.method,
					finish: f.finish,
					round: f.round ?? null,
					time: f.time ?? null,
					event: f.event_name,
					winner_id: f.winner_id ?? null,
					loser_id: f.loser_id ?? null,
					winner_name: fighterNameOf(fighters, f.winner_id) ?? f.winner_id,
					loser_name: fighterNameOf(fighters, f.loser_id) ?? f.loser_id,
					title: f.title ?? null,
				});
			}
			cursor = page.nextCursor;
		} while (cursor);
		dated.sort((a, b) => b.date.localeCompare(a.date));
		recentCache = { at: Date.now(), fights: dated.slice(0, 50) };
	}
	return recentCache.fights;
}

let recentCache: { at: number; fights: RecentFight[] } | null = null;

export interface SearchResult {
	id: string;
	name: string;
	division: string | null;
	record: string | null;
}

/** Full-text search over fighter bodies (names, teams, divisions, nationalities). */
export async function searchFighters(graph: MmaGraph, q: string): Promise<SearchResult[]> {
	const query = q.trim();
	if (!query) return [];
	const page = await graph.listNodes({ type: 'fighter', q: query, limit: 30 });
	return page.nodes.map((n) => {
		const d = n.data as Record<string, unknown>;
		const derived = d.derived as Record<string, number> | undefined;
		return {
			id: d.id as string,
			name: d.name as string,
			division: (d.division as string | undefined) ?? null,
			record: derived ? `${derived.wins}-${derived.losses}-${derived.draws}` : null,
		};
	});
}

export type FighterData = Record<string, unknown> & {
	id: string;
	name: string;
	derived?: Record<string, number>;
};

export async function getFighter(graph: MmaGraph, slug: string): Promise<FighterData | null> {
	const node = await fighterBySlug(graph, slug);
	return node ? (node.data as FighterData) : null;
}

/** The fighter's markdown body — lead paragraph first, the generated bio sentence after. */
export async function getFighterBio(graph: MmaGraph, slug: string): Promise<string | null> {
	const node = await fighterBySlug(graph, slug);
	if (!node) return null;
	const content = await graph.getNodeContent(node.id);
	return content?.body ?? null;
}

export interface FightsResult {
	fighter: string;
	count: number;
	fights: FightOutcomeView[];
}

export async function getFighterFights(
	graph: MmaGraph,
	slug: string,
): Promise<FightsResult | null> {
	const node = await fighterBySlug(graph, slug);
	if (!node) return null;
	const fighters = fighterCache.get(graph);
	const outcomes = await fightsOf(graph, node.id);
	const views = outcomes.map((o) => {
		const v = fightView(o);
		const f = o.fight as unknown as FightData;
		v.opponent_id = [f.winner_id, f.loser_id, ...(f.drew_ids ?? [])].find(
			(id) => id && id !== slug,
		);
		v.opponent_name = fighterNameOf(fighters, v.opponent_id) ?? v.opponent_id;
		return v;
	});
	return { fighter: slug, count: views.length, fights: views };
}

export interface RecordResult {
	fighter: string;
	asOf: string | null;
	record: DerivedStats;
	fights_considered: number;
}

/** Time travel: the fighter's record exactly as it stood on `asOf` (ISO date, or all time). */
export async function getRecord(
	graph: MmaGraph,
	slug: string,
	asOf?: string,
): Promise<RecordResult | null> {
	const node = await fighterBySlug(graph, slug);
	if (!node) return null;
	const outcomes = await fightsOf(graph, node.id);
	return {
		fighter: slug,
		asOf: asOf ?? null,
		record: aggregate(outcomes, asOf),
		fights_considered: asOf
			? outcomes.filter((o) => String(o.fight.date) <= asOf).length
			: outcomes.length,
	};
}

export interface Head2HeadResult {
	a: string;
	b: string;
	met: number;
	fights: FightOutcomeView[];
}

export async function getHead2Head(
	graph: MmaGraph,
	a: string,
	b: string,
): Promise<Head2HeadResult | null> {
	const nodeA = await fighterBySlug(graph, a);
	const nodeB = await fighterBySlug(graph, b);
	if (!nodeA || !nodeB) return null;
	const outcomes = await fightsOf(graph, nodeA.id);
	const shared = outcomes.filter((o) => {
		const f = o.fight as unknown as FightData;
		const ids = [f.winner_id, f.loser_id, ...(f.drew_ids ?? [])].filter(Boolean);
		return ids.includes(b);
	});
	return {
		a,
		b,
		met: shared.length,
		fights: shared.map((o) => {
			const v = fightView(o);
			v.opponent_id = b;
			return v;
		}),
	};
}

export type EventData = Record<string, unknown> & { id: string; fights?: unknown };

export async function getEvent(graph: MmaGraph, id: string): Promise<EventData | null> {
	// Events are listed by uri id; find by scanning event nodes once (small cardinality).
	let cursor: string | null = null;
	do {
		const page = await graph.listNodes({ type: 'event', limit: 2000, cursor: cursor ?? undefined });
		for (const n of page.nodes) {
			if ((n.data as { id: string }).id !== id) continue;
			const fights = await graph.neighbors(n.id, { rels: ['part_of'], direction: 'reverse' });
			const views = fights
				.map((fight) => {
					const f = fight.data as unknown as FightData;
					return {
						id: f.id,
						date: f.date,
						method: f.method,
						finish: f.finish,
						round: f.round ?? null,
						time: f.time ?? null,
						winner_id: f.winner_id ?? null,
						loser_id: f.loser_id ?? null,
						drew_ids: f.drew_ids ?? [],
						title: f.title ?? null,
					};
				})
				.sort((x, y) => (x.round ?? 0) - (y.round ?? 0) || x.date.localeCompare(y.date));
			return { ...n.data, fights: views } as EventData;
		}
		cursor = page.nextCursor;
	} while (cursor);
	return null;
}

export const LEADERBOARD_METRICS = [
	'wins',
	'losses',
	'ko_wins',
	'sub_wins',
	'dec_wins',
	'title_wins',
	'title_defenses',
	'title_fights',
	'streak_count',
] as const;

export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export interface LeaderboardRow {
	id: string;
	name: string;
	value: number;
	record: string;
	derived: Record<string, number>;
}

export interface LeaderboardResult {
	metric: string;
	count: number;
	top: LeaderboardRow[];
}

export async function getLeaderboard(
	graph: MmaGraph,
	metric: string,
	limit = 25,
): Promise<LeaderboardResult> {
	if (!(LEADERBOARD_METRICS as readonly string[]).includes(metric))
		throw new Error(`metric must be one of ${LEADERBOARD_METRICS.join(', ')}`);
	const cap = Math.min(limit, 200);
	const rows: LeaderboardRow[] = [];
	let cursor: string | null = null;
	do {
		const page = await graph.listNodes({
			type: 'fighter',
			limit: 2000,
			cursor: cursor ?? undefined,
		});
		for (const n of page.nodes) {
			const d = n.data as { id: string; name: string; derived?: Record<string, number> };
			const value = d.derived?.[metric];
			if (typeof value !== 'number') continue;
			rows.push({
				id: d.id,
				name: d.name,
				value,
				derived: d.derived ?? {},
				record: d.derived
					? `${d.derived.wins ?? 0}-${d.derived.losses ?? 0}-${d.derived.draws ?? 0}`
					: '',
			});
		}
		cursor = page.nextCursor;
	} while (cursor);
	rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
	return { metric, count: rows.length, top: rows.slice(0, cap) };
}

export interface ChampionView {
	title: string;
	champion_id: string | null;
	champion_name?: string;
	since: string;
}

/** Who held which belt on a date (or now). */
export async function getChampions(graph: MmaGraph, asOf?: string): Promise<ChampionView[]> {
	await warmFighters(graph);
	const byTitle = await titleCache.champions(graph, asOf);
	const fighters = fighterCache.get(graph);
	return [...byTitle.values()].map((e) => ({
		title: e.title,
		champion_id: e.champion_id,
		champion_name: fighterNameOf(fighters, e.champion_id) ?? e.champion_id ?? undefined,
		since: e.since,
	}));
}

/** Full reign timelines per title, oldest first. */
export async function getReigns(graph: MmaGraph): Promise<ChampionView[]> {
	await warmFighters(graph);
	const reigns = await titleCache.reigns(graph);
	const fighters = fighterCache.get(graph);
	return reigns.map((e) => ({
		title: e.title,
		champion_id: e.champion_id,
		champion_name: fighterNameOf(fighters, e.champion_id) ?? e.champion_id ?? undefined,
		since: e.since,
	}));
}
