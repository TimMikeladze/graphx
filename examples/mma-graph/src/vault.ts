/**
 * Vault emitter: turns parsed fighters into the markdown vault `graphx/ingest` reconciles.
 *
 * 1 file = 1 node: `fighter/<id>.md`, `fight/<id>.md`, `event/<id>.md`.
 *
 * Identity is the load-bearing part:
 * - fighter ids are stable slugified article titles (disambiguators folded in only on collision),
 *   assigned once and persisted in scrape state, so re-runs never re-key the graph;
 * - opponents without an article become stub fighters — real nodes whose records the graph
 *   derives from the fights they appear in;
 * - a fight is keyed by the sorted fighter pair + date (a pair meets at most once per date) and
 *   emitted once from the merged rows of BOTH fighters' tables.
 *
 * Emission is deterministic and idempotent: the same input produces byte-identical files, so
 * re-ingests are content-hash diffs.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FightRow, FighterParsed, TitleOutcome } from './parse.ts';
import { fighterNameFromTitle } from './parse.ts';

// --- ids & state -----------------------------------------------------------------------------------

export interface ScrapeState {
	/** article title | `stub:<name>` → fighter id. */
	ids: Record<string, string>;
	/** fighter id → key it was assigned from (collision detection). */
	used: Record<string, string>;
	/** event name → event id. */
	events: Record<string, string>;
	/** MediaWiki timestamp of the last tail run. */
	watermark: string | null;
	/** Every fighter article title ever scraped — the tail intersects changes against this. */
	fighterTitles: string[];
	/** Every event article title ever fetched for enrichment. */
	eventTitles: string[];
}

export function loadState(path: string): ScrapeState {
	if (!existsSync(path)) {
		return { ids: {}, used: {}, events: {}, watermark: null, fighterTitles: [], eventTitles: [] };
	}
	return JSON.parse(readFileSync(path, 'utf8')) as ScrapeState;
}

export function saveState(path: string, state: ScrapeState): void {
	writeFileSync(path, `${JSON.stringify(state, null, '\t')}\n`);
}

export function slugify(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[''.]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
}

/**
 * Stable fighter-id assignment. Base id strips `(fighter)`-style disambiguators; on a collision
 * the disambiguator is folded in, then a numeric suffix. Assignments persist in state so ids
 * survive re-runs and renames.
 */
export function assignFighterId(state: ScrapeState, key: string, displayName: string): string {
	const known = state.ids[key];
	if (known) return known;
	const base = slugify(fighterNameFromTitle(displayName)) || 'unknown';
	const paren = /\(([^)]+)\)\s*$/.exec(displayName)?.[1];
	let id = base;
	if (state.used[id] !== undefined && state.used[id] !== key) {
		id = paren ? `${base}-${slugify(paren)}` : base;
	}
	for (let n = 2; state.used[id] !== undefined && state.used[id] !== key; n++) {
		id = `${base}-${n}`;
	}
	state.ids[key] = id;
	state.used[id] = key;
	return id;
}

export function eventIdFor(state: ScrapeState, eventName: string): string {
	const known = state.events[eventName];
	if (known) return known;
	const base = slugify(eventName) || 'event';
	// Never collide with a fighter id (or another event's): ingest namespaces uris by id
	// alone, so a shared id across folders is a duplicate identity and every wikilink to
	// it turns ambiguous.
	let id = base;
	if (idTaken(state, id)) id = `${base}-event`;
	for (let n = 2; idTaken(state, id); n++) id = `${base}-${n}`;
	state.events[eventName] = id;
	return id;
}

function idTaken(state: ScrapeState, id: string): boolean {
	return state.used[id] !== undefined || Object.values(state.events).includes(id);
}

// --- fight merging ---------------------------------------------------------------------------------

export type FightFinish = 'ko' | 'tko' | 'submission' | 'decision' | 'dq' | 'draw' | 'nc' | 'other';

export interface MergedFight {
	id: string;
	/** ISO date, or null for dateless rows (early one-night tournaments). */
	date: string | null;
	/** Sorted fighter ids. */
	a: string;
	b: string;
	/** `'win'` carries winner/loser; `'draw'`/`'nc'` carry `drew`. */
	result: 'win' | 'draw' | 'nc';
	winner?: string;
	loser?: string;
	drew: string[];
	method: string;
	finish: FightFinish;
	round: number | null;
	time: string | null;
	eventName: string;
	eventArticle?: string;
	location: string;
	title?: { name: string; outcome: TitleOutcome };
	bonuses: string[];
	note: string;
	/** Display names, for the body sentence. */
	nameA: string;
	nameB: string;
	nameWinner?: string;
	nameLoser?: string;
}

export interface EmitStats {
	fighters: number;
	stubs: number;
	fights: number;
	events: number;
	mergedFromBothSides: number;
	conflicts: number;
}

/** Normalize a method string to a finish bucket. */
export function finishOf(method: string): FightFinish {
	const m = method.toLowerCase();
	if (m.startsWith('nc') || m.startsWith('no contest')) return 'nc';
	if (m.startsWith('draw')) return 'draw';
	if (/\bdq\b|disqualification/.test(m)) return 'dq';
	if (m.startsWith('technical submission')) return 'submission';
	if (m.startsWith('tko')) return 'tko';
	if (m.startsWith('ko') || m.startsWith('knockout')) return 'ko';
	if (/submission/.test(m)) return 'submission';
	if (/decision/.test(m)) return 'decision';
	return 'other';
}

export function fightKeyFor(a: string, b: string, date: string | null): string {
	const stamp = date ?? 'unknown';
	const base = [a, b].sort().join('__vs__') + '__' + stamp;
	return base;
}

interface RowSide {
	fighterId: string;
	fighterName: string;
	row: FightRow;
}

/**
 * Merge every parsed fighter's rows into one fight per (pair, date). The winner's row is the
 * preferred source; the loser's row fills gaps (a title note on the loser's side re-bases to
 * `won` for the winner when they took the belt off them).
 */
export function mergeFights(
	fighters: Array<{ parsed: FighterParsed; id: string }>,
	opponentId: (article: string | undefined, name: string) => string,
): { fights: Map<string, MergedFight>; stats: EmitStats } {
	const fights = new Map<string, MergedFight>();
	const stats: EmitStats = {
		fighters: fighters.length,
		stubs: 0,
		fights: 0,
		events: 0,
		mergedFromBothSides: 0,
		conflicts: 0,
	};
	const names = new Map<string, string>();
	for (const f of fighters) names.set(f.id, f.parsed.name);

	const byKey = new Map<string, RowSide[]>();
	for (const { parsed, id } of fighters) {
		for (const row of parsed.fights) {
			const oppId = opponentId(row.opponentArticle, row.opponent);
			names.set(oppId, row.opponent);
			const key = fightKeyFor(id, oppId, row.date);
			const sides = byKey.get(key) ?? [];
			sides.push({ fighterId: id, fighterName: parsed.name, row });
			byKey.set(key, sides);
		}
	}

	for (const [key, sides] of [...byKey].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (sides.length >= 2) stats.mergedFromBothSides++;
		const winSide = sides.find((s) => s.row.result === 'win');
		const lossSide = sides.find((s) => s.row.result === 'loss');
		if (winSide && lossSide && winSide.fighterId === lossSide.fighterId) stats.conflicts++;

		// Preferred source row: the winner's, else the first side.
		const primary = winSide ?? sides[0]!;
		const otherSide = sides.find((o) => o !== primary) ?? null;

		// Fighter ids for both corners, robust even when only one side reported the fight.
		const aId = primary.fighterId;
		const bId = otherSide?.fighterId ?? byKeyOpponentId(key, aId);
		const sorted = [aId, bId].sort();

		// Outcome: a `win` row names the winner directly; a one-sided `loss` row means the
		// OTHER corner won even though their page was never scraped. No winner at all ⇒ draw/nc.
		let result: MergedFight['result'];
		let winner: string | undefined;
		if (winSide) {
			result = 'win';
			winner = winSide.fighterId;
		} else if (lossSide) {
			result = 'win';
			winner = lossSide.fighterId === aId ? bId : aId;
		} else {
			result = sides.some((s) => s.row.result === 'draw') ? 'draw' : 'nc';
		}
		const loser = result === 'win' ? (winner === aId ? bId : aId) : undefined;
		const drew = result === 'win' ? [] : sorted;

		// Title: prefer a winner-side note. A loser-side note re-bases: their `lost` means the
		// winner took the belt, their `for` (failed challenge) means the winner defended it.
		let title = winSide?.row.title;
		if (!title) {
			const fromLosingSide =
				otherSide?.row.title ?? (primary.row.result === 'loss' ? primary.row.title : undefined);
			if (fromLosingSide) {
				const rebase = { lost: 'won', for: 'defended' } as const;
				title = {
					name: fromLosingSide.name,
					outcome: (rebase[fromLosingSide.outcome as keyof typeof rebase] ??
						fromLosingSide.outcome) as TitleOutcome,
				};
			}
		}
		if (result !== 'win') title = primary.row.title;

		const method = primary.row.method;
		const fight: MergedFight = {
			id: key,
			date: primary.row.date,
			a: sorted[0]!,
			b: sorted[1]!,
			result,
			winner,
			loser,
			drew,
			method,
			finish: finishOf(method),
			round: primary.row.round,
			time: primary.row.time,
			eventName: primary.row.event,
			eventArticle: primary.row.eventArticle,
			location: primary.row.location,
			title,
			bonuses: [...new Set(sides.flatMap((s) => s.row.bonuses))],
			note: primary.row.note,
			nameA: names.get(sorted[0]!) ?? sorted[0]!,
			nameB: names.get(sorted[1]!) ?? sorted[1]!,
			nameWinner: winner ? (names.get(winner) ?? winner) : undefined,
			nameLoser: loser ? (names.get(loser) ?? loser) : undefined,
		};
		fights.set(key, fight);
	}
	stats.fights = fights.size;
	return { fights, stats };
}

/** When only one side reported the fight, the opponent id is recoverable from the key itself. */
function byKeyOpponentId(key: string, aId: string): string {
	const parts = key.split('__');
	const b = parts[2]!;
	return b === aId ? parts[0]! : b;
}

// --- emit -------------------------------------------------------------------------------------------

export interface EventAgg {
	id: string;
	name: string;
	articles: Set<string>;
	/** Article enrichment (date/venue/city/attendance) when fetched. */
	enriched?: {
		date?: string;
		venue?: string;
		city?: string;
		attendance?: number;
		gate_usd?: number;
		promotion?: string;
	};
	fightDates: string[];
}

export interface FighterFile {
	id: string;
	name: string;
	article?: string;
	stub: boolean;
	nickname?: string;
	nationality?: string;
	birth_date?: string;
	birth_place?: string;
	height?: string;
	weight?: string;
	reach?: string;
	division?: string;
	style?: string;
	team?: string;
	residence?: string;
	record: { wins: number; losses: number; draws: number; nc: number };
	body: string;
}

export interface EmitOptions {
	vaultDir: string;
	/** Remove vault files not part of this emit (full runs only — tail runs emit subsets). */
	sweep?: boolean;
}

export interface EmitResult extends EmitStats {
	written: number;
	unchanged: number;
	removed: number;
}

/**
 * Write the whole vault. Deterministic ordering everywhere; a file is only rewritten when its
 * bytes change, so unchanged files keep their content hash and ingest skips them.
 */
export function emitVault(
	fighterFiles: FighterFile[],
	fights: Map<string, MergedFight>,
	events: Map<string, EventAgg>,
	opts: EmitOptions,
): EmitResult {
	const dirs = {
		fighter: join(opts.vaultDir, 'fighter'),
		fight: join(opts.vaultDir, 'fight'),
		event: join(opts.vaultDir, 'event'),
	};
	for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

	let written = 0;
	let unchanged = 0;
	const put = (dir: string, name: string, content: string) => {
		const path = join(dir, `${name}.md`);
		const next = `${content}\n`;
		if (existsSync(path) && readFileSync(path, 'utf8') === next) {
			unchanged++;
		} else {
			writeFileSync(path, next);
			written++;
		}
	};

	const writtenKeys = new Set<string>();
	for (const f of fighterFiles) {
		put(dirs.fighter!, f.id, fighterMarkdown(f));
		writtenKeys.add(`fighter/${f.id}.md`);
	}
	const eventIds = [...events.keys()].sort();
	const eventIdByName = new Map<string, string>();
	for (const [id, agg] of events) eventIdByName.set(agg.name, id);
	for (const id of eventIds) {
		put(dirs.event!, id, eventMarkdown(id, events.get(id)!));
		writtenKeys.add(`event/${id}.md`);
	}
	for (const key of [...fights.keys()].sort()) {
		const fight = fights.get(key)!;
		const eventId = eventIdByName.get(fight.eventName);
		put(dirs.fight!, key, fightMarkdown(fight, eventId));
		writtenKeys.add(`fight/${key}.md`);
	}

	let removed = 0;
	if (opts.sweep) {
		for (const [type, dir] of Object.entries(dirs)) {
			for (const f of readdirSync(dir)) {
				const key = `${type}/${f}`;
				if (!writtenKeys.has(key)) {
					rmSync(join(dir, f));
					removed++;
				}
			}
		}
	}

	return {
		written,
		unchanged,
		removed,
		fighters: fighterFiles.filter((f) => !f.stub).length,
		stubs: fighterFiles.filter((f) => f.stub).length,
		fights: fights.size,
		events: events.size,
		mergedFromBothSides: 0,
		conflicts: 0,
	};
}

// --- markdown builders -------------------------------------------------------------------------------

function frontmatter(data: Record<string, unknown>): string {
	return `---\n${toYaml(data).trimEnd()}\n---`;
}

/**
 * Minimal YAML emitter for the shapes frontmatter needs: scalars, scalar arrays and one-level
 * nested scalar objects. Deterministic, no dependencies. `[[wikilink]]` values MUST be quoted —
 * unquoted, YAML reads them as nested flow sequences.
 */
export function toYaml(value: unknown, indent = 0): string {
	const pad = '  '.repeat(indent);
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'string') return yamlScalar(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		return value.map((v) => `${pad}- ${toYaml(v, 0)}`).join('\n');
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).filter(
			([, v]) => v !== undefined,
		);
		if (entries.length === 0) return '{}';
		return entries
			.map(([k, v]) => {
				const key = yamlScalar(k).replace(/^'(.*)'$/, '$1');
				if (Array.isArray(v) && v.length === 0) return `${pad}${key}: []`;
				if (Array.isArray(v)) return `${pad}${key}:\n${toYaml(v, indent + 1)}`;
				if (v !== null && typeof v === 'object') {
					const inner = toYaml(v, indent + 1);
					return `${pad}${key}:\n${inner}`;
				}
				return `${pad}${key}: ${toYaml(v, 0)}`;
			})
			.join('\n');
	}
	return yamlScalar(String(value));
}

const NEEDS_QUOTES =
	/^(?:[[{>&*!|'"%@`#-?:]|-(?:\s|$)|\?(?:\s|$)|:(?:\s|$)|true$|false$|null$|~$|[-+]?[\d.]+(?:e[-+]?\d+)?$|0x)/i;

function yamlScalar(s: string): string {
	const clean = s.replace(/\s+/g, ' ').trim();
	if (
		clean === '' ||
		NEEDS_QUOTES.test(clean) ||
		/: |\s#|^:|:$|, |\{|\}|^'|'$|"|^=|^\||^\d{4}-\d{2}-\d{2}$/.test(clean) ||
		clean !== s
	) {
		return `'${clean.replace(/'/g, "''")}'`;
	}
	return clean;
}

export function fighterMarkdown(f: FighterFile): string {
	const data: Record<string, unknown> = { id: f.id, name: f.name };
	if (f.article) data.article = f.article;
	if (f.stub) data.stub = true;
	for (const key of [
		'nickname',
		'nationality',
		'birth_date',
		'birth_place',
		'height',
		'weight',
		'reach',
		'division',
		'style',
		'team',
		'residence',
	] as const) {
		if (f[key]) data[key] = f[key];
	}
	data.record = f.record;
	return `${frontmatter(data)}\n\n${f.body}\n`;
}

export function fightMarkdown(f: MergedFight, eventId?: string): string {
	const data: Record<string, unknown> = {
		id: f.id,
		result: f.result,
		event_name: f.eventName,
		method: f.method,
		finish: f.finish,
	};
	if (f.date) data.date = f.date;
	if (eventId) data.event = `[[${eventId}]]`;
	if (f.round !== null) data.round = f.round;
	if (f.time) data.time = f.time;
	if (f.location) data.location = f.location;
	if (f.title) data.title = f.title;
	if (f.bonuses.length > 0) data.bonuses = f.bonuses;
	// edgeFields targets — these become won/lost/drew/part_of edges. The plain `*_id` fields
	// duplicate the corners as node data so API queries never need an edge walk to know who
	// fought whom.
	if (f.result === 'win' && f.winner && f.loser) {
		data.winner = `[[${f.winner}]]`;
		data.loser = `[[${f.loser}]]`;
		data.winner_id = f.winner;
		data.loser_id = f.loser;
	} else {
		data.drew = f.drew.map((id) => `[[${id}]]`);
		data.drew_ids = f.drew;
	}
	if (f.note) data.note = f.note;
	return `${frontmatter(data)}\n\n${fightSentence(f)}\n`;
}

export function fightSentence(f: MergedFight): string {
	const where = f.location ? ` in ${f.location}` : '';
	const when = f.date ? ` on ${f.date}` : '';
	if (f.result === 'win' && f.nameWinner && f.nameLoser) {
		return `${f.nameWinner} defeated ${f.nameLoser} via ${f.method} at ${f.eventName}${when}${where}.`;
	}
	const [a, b] = [f.nameA, f.nameB];
	if (f.result === 'draw')
		return `${a} and ${b} fought to a draw (${f.method}) at ${f.eventName}${when}${where}.`;
	return `${a} vs ${b} at ${f.eventName}${when} ended a no contest (${f.method})${where}.`;
}

export function eventMarkdown(id: string, e: EventAgg): string {
	const data: Record<string, unknown> = { id, name: e.name };
	if (e.enriched?.promotion) data.promotion = e.enriched.promotion;
	const date = e.enriched?.date ?? e.fightDates.toSorted().at(-1);
	if (date) data.date = date;
	if (e.enriched?.venue) data.venue = e.enriched.venue;
	if (e.enriched?.city) data.city = e.enriched.city;
	if (e.enriched?.attendance) data.attendance = e.enriched.attendance;
	if (e.enriched?.gate_usd) data.gate_usd = e.enriched.gate_usd;
	data.fights = e.fightDates.length;
	const where = e.enriched?.venue
		? ` at ${e.enriched.venue}${e.enriched.city ? `, ${e.enriched.city}` : ''}`
		: '';
	const promo = e.enriched?.promotion ? `${e.enriched.promotion} event` : 'MMA event';
	return `${frontmatter(data)}\n\n${e.name}: a ${promo} on ${date ?? 'an unknown date'}${where}, ${e.fightDates.length} fights in this graph.\n`;
}

// --- promotion inference -----------------------------------------------------------------------------

const PROMOTIONS: Array<[RegExp, string]> = [
	[/^the ultimate fighter/i, 'Ultimate Fighting Championship'],
	[/^ufc(\s|$|:)/i, 'Ultimate Fighting Championship'],
	[/^pride\b|^pride fc/i, 'PRIDE FC'],
	[/^strikeforce/i, 'Strikeforce'],
	[/^bellator/i, 'Bellator MMA'],
	[
		/^pfl|^professional fighters league|^wsOF|^world series of fighting/i,
		'Professional Fighters League',
	],
	[/^wec\b|^world extreme cagefighting/i, 'WEC'],
	[/^invicta/i, 'Invicta FC'],
	[/^one (championship|fc|fight night)/i, 'ONE Championship'],
	[/^rizin/i, 'Rizin FF'],
	[/^cage warriors/i, 'Cage Warriors'],
	[/^elite ?xc/i, 'EliteXC'],
	[/^affliction/i, 'Affliction'],
	[/^ksw/i, 'KSW'],
	[/^pancrase/i, 'Pancrase'],
	[/^shooto/i, 'Shooto'],
	[/^deep\b/i, 'DEEP'],
	[/^jungle fight/i, 'Jungle Fight'],
];

export function promotionOf(eventName: string): string | undefined {
	for (const [re, name] of PROMOTIONS) if (re.test(eventName)) return name;
	return undefined;
}
