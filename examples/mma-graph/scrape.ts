/**
 * The MMA scraper CLI.
 *
 *   bun scrape.ts fighters [--limit N] [--fresh]   base corpus: both list pages → every fighter
 *                                                   article (waves until closure, so linked
 *                                                   opponents missing from the lists get scraped
 *                                                   too) → vault
 *   bun scrape.ts events [--fresh]                 event articles referenced by fights
 *   bun scrape.ts full [--limit N]                 fighters + events, with sweep
 *   bun scrape.ts tail [--since ISO] [--watch [s]] recentchanges → refetch changed known pages
 *   bun scrape.ts event "UFC 909" [--interval s]   one card's article + roster, polled
 *
 * Every run rebuilds the vault from the disk cache (network only for pages not cached or
 * expired), so emission is one deterministic path — tail runs re-parse everything they have
 * locally and write only the files whose bytes changed.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parseEvent, parseFighter, type FighterParsed } from './src/parse.ts';
import {
	assignFighterId,
	emitVault,
	eventIdFor,
	loadState,
	mergeFights,
	promotionOf,
	saveState,
	type EventAgg,
	type FighterFile,
	type ScrapeState,
} from './src/vault.ts';
import { createWiki, type PageContent, type Wiki } from './src/wiki.ts';

const ROOT = import.meta.dir;
const VAULT_DIR = join(ROOT, 'vault');
const STATE_PATH = join(ROOT, '.scrape-state.json');

const LIST_PAGES = ['List of male mixed martial artists', 'List of female mixed martial artists'];

interface Args {
	command: string;
	limit?: number;
	fresh?: boolean;
	sweep?: boolean;
	since?: string;
	watch?: number;
	interval?: number;
	title?: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { command: argv[0] ?? 'full' };
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--limit') args.limit = Number(argv[++i]);
		else if (a === '--fresh') args.fresh = true;
		else if (a === '--no-sweep') args.sweep = false;
		else if (a === '--since') args.since = argv[++i];
		else if (a === '--watch') args.watch = Number(argv[++i] ?? 300);
		else if (a === '--interval') args.interval = Number(argv[++i]);
		else if (a === '--title') args.title = argv[++i];
		else args.title ??= a; // positional: event title for `event`
	}
	return args;
}

// --- corpus pipeline -------------------------------------------------------------------------------

interface Corpus {
	state: ScrapeState;
	fighters: Array<{ parsed: FighterParsed; id: string }>;
}

/**
 * Parse every fighter page available — from `wiki` for pages worth fetching (cache decides
 * whether the network is involved) plus any extra pages already parsed by the caller.
 */
async function buildCorpus(
	wiki: Wiki,
	state: ScrapeState,
	titles: string[],
	opts: { ttlMs?: number; progress?: string },
	extra: Array<{ title: string; page: PageContent }> = [],
): Promise<Corpus> {
	const parsed = new Map<string, FighterParsed>();
	let done = 0;
	const pages = await wiki.getPages(titles, {
		ttlMs: opts.ttlMs,
		onBatch: (d, t) => {
			done = d;
			if (opts.progress && d % 200 === 0) console.log(`${opts.progress} ${done}/${t}`);
		},
	});
	for (const page of pages.values()) {
		const fighter = parseFighter(page.title, page.wikitext);
		if (fighter) parsed.set(page.title, fighter);
	}
	for (const { title, page } of extra) {
		const fighter = parseFighter(title, page.wikitext);
		if (fighter) parsed.set(title, fighter);
	}

	// Deterministic order → deterministic id assignment across runs.
	const fighters = [...parsed.values()]
		.sort((a, b) => (a.title < b.title ? -1 : 1))
		.map((p) => ({ parsed: p, id: assignFighterId(state, p.title, p.title) }));
	return { state, fighters };
}

/** Build the full vault view from a corpus: fighters, fights, events. */
function buildVaultData(corpus: Corpus) {
	const { state, fighters } = corpus;

	const opponentId = (article: string | undefined, name: string) =>
		article
			? assignFighterId(state, article, article)
			: assignFighterId(state, `stub:${name}`, name);

	const { fights } = mergeFights(fighters, opponentId);

	// Fighter files: article fighters from their own rows; stubs from fights they appear in.
	const fighterFiles: FighterFile[] = [];
	const stubNames = new Map<string, string>();
	for (const { parsed, id } of fighters) {
		const record = { wins: 0, losses: 0, draws: 0, nc: 0 };
		for (const row of parsed.fights) {
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
		fighterFiles.push({
			id,
			name: parsed.name,
			article: parsed.title,
			stub: false,
			nickname: parsed.infobox.nickname || undefined,
			nationality: parsed.infobox.nationality || undefined,
			birth_date: parsed.infobox.birth_date || undefined,
			birth_place: parsed.infobox.birth_place || undefined,
			height: parsed.infobox.height || undefined,
			weight: parsed.infobox.weight || undefined,
			reach: parsed.infobox.reach || undefined,
			division: parsed.infobox.division || undefined,
			style: parsed.infobox.style || undefined,
			team: parsed.infobox.team || undefined,
			residence: parsed.infobox.residence || undefined,
			record,
			body: fighterBody(parsed, record),
		});
	}

	// Every fight corner that has no article fighter file → stub file.
	const known = new Set(fighters.map((f) => f.id));
	const stubCount = new Map<string, { wins: number; losses: number; draws: number; nc: number }>();
	for (const fight of fights.values()) {
		for (const id of fight.result === 'win' ? [fight.winner!, fight.loser!] : fight.drew) {
			if (known.has(id)) continue;
			const rec = stubCount.get(id) ?? { wins: 0, losses: 0, draws: 0, nc: 0 };
			if (fight.result === 'win') {
				if (id === fight.winner) rec.wins++;
				else rec.losses++;
			} else if (fight.result === 'draw') rec.draws++;
			else rec.nc++;
			stubCount.set(id, rec);
			stubNames.set(id, id === fight.a ? fight.nameA : fight.nameB);
		}
	}
	for (const [id, record] of [...stubCount].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const name = stubNames.get(id) ?? id;
		fighterFiles.push({
			id,
			name,
			stub: true,
			record,
			body: `${name} is a mixed martial artist with no Wikipedia article — every fight in this graph comes from an opponent's record. Record ${record.wins}–${record.losses}–${record.draws}${record.nc ? ` (${record.nc} NC)` : ''}.`,
		});
	}

	// Events from fights.
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

	return { fighterFiles, fights, events };
}

function fighterBody(
	p: FighterParsed,
	record: { wins: number; losses: number; draws: number; nc: number },
): string {
	const bits: string[] = [p.name];
	if (p.infobox.nickname) bits.push(`nicknamed "${p.infobox.nickname}"`);
	if (p.infobox.nationality) bits.push(`${p.infobox.nationality} mixed martial artist`);
	else bits.push('mixed martial artist');
	if (p.infobox.division) bits.push(`competing at ${p.infobox.division}`);
	if (p.infobox.team) bits.push(`of ${p.infobox.team}`);
	const bio = `${bits.join(', ')}. Record ${record.wins}–${record.losses}–${record.draws}${record.nc ? ` (${record.nc} NC)` : ''}.`;
	return p.lead ? `${p.lead}\n\n${bio}` : bio;
}

/** Event-article enrichment: fetch known event articles, fold their infobox into event files. */
async function enrichEvents(
	wiki: Wiki,
	state: ScrapeState,
	events: Map<string, EventAgg>,
	ttlMs?: number,
) {
	const titles = new Set<string>();
	for (const agg of events.values()) for (const t of agg.articles) titles.add(t);
	const missing = [...titles].filter((t) => !state.eventTitles.includes(t));
	if (missing.length > 0) state.eventTitles.push(...missing);

	const pages = await wiki.getPages([...titles], { ttlMs });
	let enriched = 0;
	for (const agg of events.values()) {
		for (const article of agg.articles) {
			const page = pages.get(article);
			if (!page) continue;
			const event = parseEvent(article, page.wikitext);
			if (!event) continue;
			agg.enriched = {
				date: event.date,
				venue: event.venue,
				city: event.city,
				attendance: event.attendance,
				gate_usd: event.gate_usd,
				promotion: event.promotion ?? promotionOf(agg.name),
			};
			enriched++;
			break;
		}
	}
	return enriched;
}

/** Emit + report, shared by every subcommand. */
function emitAll(corpus: Corpus, sweep: boolean) {
	const { fighterFiles, fights, events } = buildVaultData(corpus);
	const result = emitVault(fighterFiles, fights, events, { vaultDir: VAULT_DIR, sweep });
	console.log(
		`[vault] ${result.fighters} fighters (+${result.stubs} stubs), ${result.fights} fights, ${result.events} events — ` +
			`${result.written} written, ${result.unchanged} unchanged, ${result.removed} removed`,
	);
	return result;
}

// --- subcommands -------------------------------------------------------------------------------------

async function cmdFighters(args: Args, wiki: Wiki, state: ScrapeState) {
	const ttlMs = args.fresh ? 0 : undefined;
	console.log('[scrape] fighter list pages…');
	const listed = new Set<string>();
	for (const page of LIST_PAGES) {
		for (const link of await wiki.getLinks(page, args.fresh ? 0 : undefined)) listed.add(link);
	}
	console.log(`[scrape] ${listed.size} fighter articles from the lists`);

	// Wave 1: the listed articles. Wave 2: linked opponents the lists missed (closure).
	const wave1 = [...listed].sort().slice(0, args.limit);
	const corpus1 = await buildCorpus(wiki, state, wave1, { ttlMs, progress: '[scrape] wave 1' });
	const linked = new Set<string>();
	for (const { parsed } of corpus1.fighters) {
		for (const row of parsed.fights) if (row.opponentArticle) linked.add(row.opponentArticle);
	}
	const known = new Set(wave1);
	const wave2 = [...linked]
		.filter((t) => !known.has(t))
		.sort()
		.slice(0, args.limit);
	if (wave2.length > 0) {
		console.log(`[scrape] wave 2: ${wave2.length} linked opponents not in the lists`);
		await buildCorpus(wiki, state, wave2, { ttlMs, progress: '[scrape] wave 2' });
	}

	// Final emit from the full corpus — every page now on disk, so this pass is offline.
	const all = [...new Set([...wave1, ...wave2])].sort();
	const corpus = await buildCorpus(wiki, state, all, { ttlMs: Number.POSITIVE_INFINITY });
	for (const { parsed } of corpus.fighters) state.fighterTitles.push(parsed.title);
	state.fighterTitles = [...new Set(state.fighterTitles)];
	emitAll(corpus, true);
}

async function cmdEvents(wiki: Wiki, state: ScrapeState) {
	// Rebuild from whatever is cached/full corpus; events need fighters parsed first.
	const corpus = await buildCorpus(wiki, state, state.fighterTitles, { ttlMs: undefined });
	const { fighterFiles, fights, events } = buildVaultData(corpus);
	console.log(`[scrape] enriching ${events.size} events…`);
	const enriched = await enrichEvents(wiki, state, events, undefined);
	const result = emitVault(fighterFiles, fights, events, { vaultDir: VAULT_DIR, sweep: true });
	console.log(`[scrape] ${enriched} events enriched from their articles`);
	console.log(
		`[vault] ${result.fights} fights, ${result.events} events — ${result.written} written, ${result.unchanged} unchanged`,
	);
}

async function cmdTail(args: Args, wiki: Wiki, state: ScrapeState) {
	const since = args.since ?? state.watermark ?? undefined;
	console.log(`[tail] since ${since ?? '(latest window)'}`);
	const { changes, latest } = await wiki.getRecentChanges(since);
	const knownFighters = new Set(state.fighterTitles);
	const knownEvents = new Set(state.eventTitles);
	const touchedFighters = [
		...new Set(changes.filter((c) => knownFighters.has(c.title)).map((c) => c.title)),
	];
	const touchedEvents = [
		...new Set(changes.filter((c) => knownEvents.has(c.title)).map((c) => c.title)),
	];
	console.log(
		`[tail] ${changes.length} changes → ${touchedFighters.length} known fighters, ${touchedEvents.length} known events`,
	);

	// Full rebuild, but only the touched pages hit the network (cache TTL 0); the rest is disk.
	const untouched = state.fighterTitles.filter((t) => !touchedFighters.includes(t));
	const base = await buildCorpus(wiki, state, untouched, { ttlMs: Number.POSITIVE_INFINITY });
	const fresh = await buildCorpus(wiki, state, touchedFighters, { ttlMs: 0 });
	const merged = mergeCorpus(base, fresh);
	const { fighterFiles, fights, events } = buildVaultData(merged);
	if (touchedEvents.length > 0) await enrichEvents(wiki, state, events, 0);
	const result = emitVault(fighterFiles, fights, events, { vaultDir: VAULT_DIR, sweep: false });
	console.log(
		`[tail] vault updated — ${result.written} written, ${result.unchanged} unchanged; re-run load to reconcile the graph`,
	);
	state.watermark = latest;
}

function mergeCorpus(a: Corpus, b: Corpus): Corpus {
	const byTitle = new Map(a.fighters.map((f) => [f.parsed.title, f]));
	for (const f of b.fighters) byTitle.set(f.parsed.title, f);
	return {
		state: a.state,
		fighters: [...byTitle.values()].sort((x, y) => (x.parsed.title < y.parsed.title ? -1 : 1)),
	};
}

async function cmdEvent(args: Args, wiki: Wiki, state: ScrapeState) {
	if (!args.title) {
		console.error('usage: bun scrape.ts event "UFC 909" [--interval 30]');
		process.exit(1);
	}
	const interval = (args.interval ?? 30) * 1000;
	console.log(`[event] polling "${args.title}" every ${interval / 1000}s — Ctrl-C to stop`);
	for (;;) {
		const page = (await wiki.getPages([args.title], { ttlMs: 0 })).get(args.title);
		if (page) {
			const event = parseEvent(args.title, page.wikitext);
			console.log(
				`[event] ${new Date().toISOString()} — ${event?.date ?? 'date TBD'} @ ${event?.venue ?? '?'}`,
			);
		}
		const corpus = await buildCorpus(wiki, state, state.fighterTitles, {
			ttlMs: Number.POSITIVE_INFINITY,
		});
		const { fighterFiles, fights, events } = buildVaultData(corpus);
		await enrichEvents(wiki, state, events, 0);
		emitVault(fighterFiles, fights, events, { vaultDir: VAULT_DIR, sweep: false });
		await new Promise((r) => setTimeout(r, interval));
	}
}

// --- main --------------------------------------------------------------------------------------------

mkdirSync(VAULT_DIR, { recursive: true });
const args = parseArgs(process.argv.slice(2));
const wiki = createWiki({ cacheDir: join(ROOT, '.cache', 'requests') });
const state = loadState(STATE_PATH);

switch (args.command) {
	case 'fighters':
		await cmdFighters(args, wiki, state);
		break;
	case 'events':
		await cmdEvents(wiki, state);
		break;
	case 'full':
		await cmdFighters(args, wiki, state);
		await cmdEvents(wiki, state);
		break;
	case 'tail': {
		const watch = args.watch;
		do {
			await cmdTail(args, wiki, state);
			saveState(STATE_PATH, state);
			if (watch !== undefined) {
				console.log(`[tail] sleeping ${watch}s…`);
				await new Promise((r) => setTimeout(r, watch * 1000));
			}
		} while (watch !== undefined);
		break;
	}
	case 'event':
		await cmdEvent(args, wiki, state);
		break;
	default:
		console.error(`unknown command "${args.command}" — fighters | events | full | tail | event`);
		process.exit(1);
}
saveState(STATE_PATH, state);
console.log('[done] state saved');
