/**
 * "More like this": titles similar to one anime, from outside its own franchise.
 *
 *   bun run similar.ts ["Shingeki no Kyojin"] [--limit 10] [--shortlist 40]
 *
 * 1. Candidates share tags with the seed through `taggedWith`. Each shared tag is weighted by
 *    its rarity (idf), so "dark fantasy" counts for more than "action".
 * 2. The seed's franchise is excluded: everything within 2 hops over `relatedTo`. The whole
 *    connected component is far too wide — crossovers and compilations chain thousands of
 *    unrelated series together.
 * 3. With `TYPESAFE_API_KEY` set, Jev reads the seed and each shortlisted candidate and judges
 *    whether a fan of the seed would like it for the same reasons. Without a key, tag overlap
 *    is the answer.
 *
 * The SQL is portable, so the web app (`web/`) runs the same function against Postgres.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { DbClient } from 'graphx/core';
import { jevRerank, noul } from 'graphx/jev';

export interface Anime {
	title: string;
	type: string;
	year?: number;
	score?: number;
	picture?: string;
	thumbnail?: string;
	tags: string[];
	synonyms: string[];
}

export interface Similar {
	id: string;
	anime: Anime;
	/** Summed idf of the shared tags. */
	tagWeight: number;
	/** Jev's probability that a fan of the seed would enjoy it; absent without a key. */
	jev?: number;
}

export interface SimilarResult {
	seed: { id: string; anime: Anime };
	franchiseSize: number;
	/** By `jev` when judged, else by `tagWeight`. */
	results: Similar[];
	judged: boolean;
}

async function dataOf(db: DbClient, ids: string[]): Promise<Map<string, Anime>> {
	const out = new Map<string, Anime>();
	if (!ids.length) return out;
	const r = await db.execute({
		sql: `SELECT id, data FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`,
		args: ids,
	});
	for (const row of r.rows) {
		const data = row.data;
		out.set(String(row.id), (typeof data === 'string' ? JSON.parse(data) : data) as Anime);
	}
	return out;
}

/** The seed's 2-hop `relatedTo` neighbourhood, both directions. */
async function franchiseOf(db: DbClient, seedId: string): Promise<Set<string>> {
	const seen = new Set([seedId]);
	let frontier = [seedId];
	for (let hop = 0; hop < 2 && frontier.length; hop++) {
		const marks = frontier.map(() => '?').join(',');
		const r = await db.execute({
			sql: `SELECT src, dst FROM edges WHERE rel = 'relatedTo' AND (src IN (${marks}) OR dst IN (${marks}))`,
			args: [...frontier, ...frontier],
		});
		const next: string[] = [];
		for (const row of r.rows) {
			for (const id of [String(row.src), String(row.dst)]) {
				if (seen.has(id)) continue;
				seen.add(id);
				next.push(id);
			}
		}
		frontier = next;
	}
	return seen;
}

export async function similarTo(
	db: DbClient,
	seedId: string,
	opts: { shortlist?: number; jev?: boolean } = {},
): Promise<SimilarResult> {
	const shortlist = opts.shortlist ?? 40;
	const seed = (await dataOf(db, [seedId])).get(seedId);
	if (!seed) throw new Error(`no anime '${seedId}'`);
	const franchise = await franchiseOf(db, seedId);

	const total = Number(
		(await db.execute("SELECT count(*) AS c FROM nodes WHERE type = 'anime'")).rows[0]!.c,
	);
	const rows = (
		await db.execute({
			sql: `SELECT e.src AS id, sum(ln(CAST(? AS DOUBLE PRECISION) / df.n)) AS w
			      FROM edges e
			      JOIN (SELECT dst, count(*) AS n FROM edges
			            WHERE rel = 'taggedWith'
			              AND dst IN (SELECT dst FROM edges WHERE rel = 'taggedWith' AND src = ?)
			            GROUP BY dst) df ON df.dst = e.dst
			      WHERE e.rel = 'taggedWith' AND e.src <> ?
			      GROUP BY e.src ORDER BY w DESC LIMIT 400`,
			args: [total, seedId, seedId],
		})
	).rows;
	const picked = rows
		.map((r) => ({ id: String(r.id), w: Number(r.w) }))
		.filter((r) => !franchise.has(r.id))
		.slice(0, shortlist);
	const data = await dataOf(
		db,
		picked.map((p) => p.id),
	);
	let results: Similar[] = picked.map((p) => ({
		id: p.id,
		anime: data.get(p.id)!,
		tagWeight: p.w,
	}));

	const judged = (opts.jev ?? true) && Boolean(process.env.TYPESAFE_API_KEY);
	if (judged) {
		const describe = (d: Anime) => ({
			title: d.title,
			format: d.type,
			year: d.year ?? null,
			alsoKnownAs: d.synonyms.slice(0, 4),
			tags: d.tags.slice(0, 40),
		});
		const judge = jevRerank({
			onError: 'keep',
			question: noul(
				'Would someone who loved the seed anime enjoy the candidate for the same reasons — its themes, tone and kind of story, not just its genre label?',
			),
			state: (_q, c) => ({ seed: describe(seed), candidate: describe(c.data as Anime) }),
		});
		const scores = new Map(
			(
				await judge(
					seed.title,
					results.map((r) => ({ id: r.id, type: 'anime', data: r.anime })) as never,
				)
			).map((s) => [s.id, s.score]),
		);
		results = results
			.map((r) => ({ ...r, jev: scores.get(r.id) }))
			.sort((a, b) => (b.jev ?? 0) - (a.jev ?? 0));
	}
	return { seed: { id: seedId, anime: seed }, franchiseSize: franchise.size, results, judged };
}

if (import.meta.main) {
	const { getDb } = await import('graphx');
	const { NAMESPACE } = await import('./graphx.config.ts');
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			limit: { type: 'string', default: '10' },
			shortlist: { type: 'string', default: '40' },
			db: { type: 'string', default: join(import.meta.dir, NAMESPACE) },
		},
	});
	const title = positionals[0] ?? 'Shingeki no Kyojin';
	const db = getDb(values.db as string);
	const seedRow = (
		await db.execute({
			sql: "SELECT id FROM nodes WHERE type = 'anime' AND json_extract(data, '$.title') = ?",
			args: [title],
		})
	).rows[0];
	if (!seedRow) throw new Error(`no anime titled '${title}'`);

	const label = (d: Anime) =>
		`${d.title} (${d.type}${d.year ? `, ${d.year}` : ''}${d.score ? `, ${d.score.toFixed(2)}` : ''})`;
	const limit = Number(values.limit);
	const t = performance.now();
	const r = await similarTo(db, String(seedRow.id), { shortlist: Number(values.shortlist) });

	console.log(
		`similar to ${label(r.seed.anime)} — franchise of ${r.franchiseSize} titles excluded\n`,
	);
	console.log(
		`by shared tags (idf-weighted), top ${limit} of a ${r.results.length}-title shortlist:`,
	);
	for (const s of [...r.results].sort((a, b) => b.tagWeight - a.tagWeight).slice(0, limit)) {
		console.log(`  ${s.tagWeight.toFixed(1).padStart(6)}  ${label(s.anime)}`);
	}
	if (!r.judged) console.log('\nset TYPESAFE_API_KEY to have Jev judge the shortlist');
	else {
		console.log(
			`\njudged by Jev — "would a fan of ${r.seed.anime.title} enjoy this for the same reasons?":`,
		);
		for (const s of r.results.slice(0, limit)) {
			console.log(`  ${(s.jev ?? 0).toFixed(2).padStart(6)}  ${label(s.anime)}`);
		}
		console.log(
			`  ${r.results.length} Jev requests, ${((performance.now() - t) / 1000).toFixed(1)}s total`,
		);
	}
	db.close();
}
