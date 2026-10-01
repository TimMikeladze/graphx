/**
 * Load the scraped vault into a graphx graph and derive per-fighter win stats from the fight
 * graph itself — stub fighters (no Wikipedia article) get their whole record this way, and
 * article fighters get stats the graph can reproduce rather than numbers we trust on faith.
 *
 * The Next.js server (src/server/runtime.ts) runs {@link ingestVault} against the graphx-served
 * graph handle inside `createApp`'s `seed` hook. {@link buildGraph} wraps the same pipeline over
 * its own db — the tests' entry point.
 *
 * Re-running `ingestDir` reconciles a diff (unchanged files skipped by content hash, vanished
 * files retracted with `prune`); the derived pass then only writes fighters whose numbers moved.
 */
import { getDb, hashEmbed, init, Graph } from 'graphx';
import { ingestDir, type IngestResult } from 'graphx/ingest';
import { mmaSchema, type MmaSchema } from './schema.ts';

/** The db handle `getDb` returns (libSQL client under a structural interface). */
type DbHandle = ReturnType<typeof getDb>;

export interface DerivedStats {
	wins: number;
	losses: number;
	draws: number;
	nc: number;
	ko_wins: number;
	sub_wins: number;
	dec_wins: number;
	other_wins: number;
	ko_losses: number;
	sub_losses: number;
	dec_losses: number;
	other_losses: number;
	win_rate: number | null;
	title_fights: number;
	title_wins: number;
	title_defenses: number;
	streak_type: 'win' | 'loss' | 'draw' | 'nc' | null;
	streak_count: number;
	active_from: string | null;
	active_to: string | null;
}

export interface BuildOptions {
	vaultDir: string;
	/** Reuse an already-open db (tests); otherwise `getDb(namespace)` is used. */
	db?: DbHandle;
	/** getDb namespace — resolves to `file:<namespace>.db` in the process cwd. */
	namespace?: string;
}

export interface BuildResult {
	graph: Graph<MmaSchema>;
	db: DbHandle;
	result: IngestResult;
	derived: { fighters: number; updated: number };
}

/** Ingest a vault directory into an open graph, then run the derived-stats pass. */
export async function ingestVault(
	graph: Graph<MmaSchema>,
	vaultDir: string,
): Promise<{ result: IngestResult; derived: { fighters: number; updated: number } }> {
	const result = await ingestDir({
		dir: vaultDir,
		graph,
		source: 'wikipedia-mma',
		idField: 'id',
		edgeFields: { winner: 'won', loser: 'lost', drew: 'drew', event: 'part_of' },
		prune: true,
	});
	const derived = await deriveFighterStats(graph);
	return { result, derived };
}

export async function buildGraph(opts: BuildOptions): Promise<BuildResult> {
	const db = opts.db ?? getDb(opts.namespace ?? 'mma_demo');
	const embedder = hashEmbed(128);
	await init(db, embedder);
	const graph = new Graph(db, mmaSchema, { embedder });
	const { result, derived } = await ingestVault(graph, opts.vaultDir);
	return { graph, db, result, derived };
}

function emptyStats(): DerivedStats {
	return {
		wins: 0,
		losses: 0,
		draws: 0,
		nc: 0,
		ko_wins: 0,
		sub_wins: 0,
		dec_wins: 0,
		other_wins: 0,
		ko_losses: 0,
		sub_losses: 0,
		dec_losses: 0,
		other_losses: 0,
		win_rate: null,
		title_fights: 0,
		title_wins: 0,
		title_defenses: 0,
		streak_type: null,
		streak_count: 0,
		active_from: null,
		active_to: null,
	};
}

export interface FightOutcome {
	fightId: string;
	outcome: 'win' | 'loss' | 'draw' | 'nc';
	fight: Record<string, unknown>;
}

/**
 * All fights of one fighter with the outcome from their perspective, newest first.
 * Reverse-neighbors per rel — the rel IS the outcome.
 */
export async function fightsOf(
	graph: Graph<MmaSchema>,
	fighterId: string,
): Promise<FightOutcome[]> {
	const out: FightOutcome[] = [];
	for (const [rel, outcome] of [
		['won', 'win'],
		['lost', 'loss'],
		['drew', 'draw'],
	] as const) {
		for (const node of await graph.neighbors(fighterId, { rels: [rel], direction: 'reverse' })) {
			out.push({
				fightId: node.id,
				outcome,
				fight: node.data,
			});
		}
	}
	// NC fights sit on `drew` edges; the fight node's own `result` distinguishes them.
	for (const f of out) {
		if (f.outcome === 'draw' && (f.fight as { result?: string }).result === 'nc') f.outcome = 'nc';
	}
	out.sort((a, b) => String(b.fight.date ?? '').localeCompare(String(a.fight.date ?? '')));
	return out;
}

/** Compute + write back `derived` stats for every fighter whose numbers changed. */
export async function deriveFighterStats(
	graph: Graph<MmaSchema>,
): Promise<{ fighters: number; updated: number }> {
	let cursor: string | null = null;
	const fighters: Array<{ id: string; data: Record<string, unknown> }> = [];
	do {
		const page = await graph.listNodes({
			type: 'fighter',
			limit: 2000,
			cursor: cursor ?? undefined,
		});
		for (const n of page.nodes)
			fighters.push({ id: n.id, data: n.data as Record<string, unknown> });
		cursor = page.nextCursor;
	} while (cursor);

	let updated = 0;
	for (const fighter of fighters) {
		const outcomes = await fightsOf(graph, fighter.id);
		const stats = aggregate(outcomes);
		const prev = fighter.data.derived as DerivedStats | undefined;
		if (JSON.stringify(prev) === JSON.stringify(stats)) continue;
		await graph.updateNode(fighter.id, { data: { derived: stats } });
		updated++;
	}
	return { fighters: fighters.length, updated };
}

/** Pure aggregation over a fighter's fight outcomes — also the engine of `/api/record?asOf=`. */
export function aggregate(outcomes: FightOutcome[], asOf?: string): DerivedStats {
	const s = emptyStats();
	const applicable = asOf
		? outcomes.filter((o) => o.fight.date !== undefined && String(o.fight.date) <= asOf)
		: outcomes;
	const chrono = [...applicable].sort((a, b) =>
		String(a.fight.date).localeCompare(String(b.fight.date)),
	);
	const bucket = (finish: unknown): 'ko' | 'sub' | 'dec' | 'other' => {
		const f = String(finish);
		if (f === 'ko' || f === 'tko') return 'ko';
		if (f === 'submission') return 'sub';
		if (f === 'decision') return 'dec';
		return 'other';
	};
	for (const o of chrono) {
		const finish = bucket(o.fight.finish);
		const title = o.fight.title as { outcome?: string } | undefined;
		if (title) s.title_fights++;
		if (o.outcome === 'win') {
			s.wins++;
			s[
				`${finish === 'sub' ? 'sub' : finish === 'dec' ? 'dec' : finish === 'ko' ? 'ko' : 'other'}_wins`
			]++;
			if (title && (title.outcome === 'won' || title.outcome === 'defended')) {
				if (title.outcome === 'won') s.title_wins++;
				else s.title_defenses++;
			}
		} else if (o.outcome === 'loss') {
			s.losses++;
			s[
				`${finish === 'sub' ? 'sub' : finish === 'dec' ? 'dec' : finish === 'ko' ? 'ko' : 'other'}_losses`
			]++;
		} else if (o.outcome === 'draw') {
			s.draws++;
		} else {
			s.nc++;
		}
		if (o.outcome === 'draw' && title?.outcome === 'defended') s.title_defenses++;
	}
	const decided = s.wins + s.losses;
	s.win_rate = decided > 0 ? Number((s.wins / decided).toFixed(4)) : null;
	if (chrono.length > 0) {
		s.active_from = String(chrono[0]!.fight.date ?? '');
		s.active_to = String(chrono.at(-1)!.fight.date ?? '');
		// Streak: count identical outcomes from the most recent fight backwards.
		const last = chrono.at(-1)!.outcome;
		let count = 0;
		for (let i = chrono.length - 1; i >= 0 && chrono[i]!.outcome === last; i--) count++;
		s.streak_type = last;
		s.streak_count = count;
	}
	return s;
}
