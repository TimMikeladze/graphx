/**
 * The web app's API — a plain `(Request) => Response` over the Postgres-loaded graph, so it runs
 * the same on Vercel (`vercel-entry.ts`) and locally (`dev.ts`).
 *
 *   GET /api/search?q=…   hybridRetrieve over anime, reranked by Jev when TYPESAFE_API_KEY is set
 *   GET /api/anime/:id    one title, its direct relatedTo neighbours, and similarTo()
 *   GET /api/graph/:id    one node and a capped slice of its neighbours, for the graph explorer
 *   GET /api/title?t=…    exact title lookup
 *   GET /api/meta         the dataset node: release, license, attribution
 */
import { Graph, hashEmbed, match, type DbClient } from 'graphx/core';
import { createPgClient } from 'graphx/pg';
import { animeRerank, hasJevKey } from '../rerank.ts';
import { animeSchema } from '../schema.ts';
import { type Anime, similarTo } from '../similar.ts';

// Must be the embedder the database was loaded with (load.ts's default).
const embedder = hashEmbed(256);
let db: DbClient | undefined;
let graph: Graph<typeof animeSchema> | undefined;

function open(): { db: DbClient; g: Graph<typeof animeSchema> } {
	if (!db) {
		const url = process.env.DATABASE_URL;
		if (!url) throw new Error('DATABASE_URL is not set');
		db = createPgClient({ connectionString: url, max: 3 });
		graph = new Graph(db, animeSchema, { embedder });
	}
	return { db, g: graph! };
}

const card = (id: string, d: Anime) => ({
	id,
	title: d.title,
	type: d.type,
	year: d.year ?? null,
	score: d.score ?? null,
	thumbnail: d.thumbnail ?? null,
	tags: d.tags.slice(0, 6),
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
	});

export async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url);
	try {
		const { db, g } = open();

		if (url.pathname === '/api/title') {
			// Exact title lookup — the graph explorer's starting point.
			const title = (url.searchParams.get('t') ?? '').slice(0, 200);
			const rows = await (
				await match(animeSchema, db).node('a', 'anime').where('a', 'title', title).select('a')
			).run();
			return json({ results: rows.slice(0, 5).map((r) => card(r.a.id, r.a.data as Anime)) });
		}

		if (url.pathname === '/api/search') {
			const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
			if (!q) return json({ results: [] });
			const shortlist = (await g.hybridRetrieve({ query: q, k: 40, maxDepth: 0 })).filter(
				(h) => h.type === 'anime',
			);
			let rows = shortlist.map((h) => ({ h, score: h.score ?? 0 }));
			const reranked = hasJevKey() && url.searchParams.get('rerank') !== '0';
			if (reranked) {
				const scores = new Map((await animeRerank()(q, shortlist)).map((s) => [s.id, s.score]));
				rows = shortlist
					.map((h) => ({ h, score: scores.get(h.id) ?? 0 }))
					.sort((a, b) => b.score - a.score);
			}
			return json({
				reranked,
				results: rows
					.slice(0, 12)
					.map(({ h, score }) => ({ ...card(h.id, h.data as Anime), match: score })),
			});
		}

		const m = /^\/api\/anime\/([0-9A-Z]{26})$/.exec(url.pathname);
		if (m) {
			const id = m[1]!;
			const node = await g.getNode(id);
			if (!node || node.type !== 'anime') return json({ error: 'not found' }, 404);
			const [related, similar] = await Promise.all([
				g.neighbors(id, { rels: ['relatedTo'], direction: 'forward' }),
				similarTo(db, id, { shortlist: 30 }),
			]);
			const d = node.data as Anime & { sources: string[]; synonyms: string[] };
			return json({
				anime: {
					...card(id, d),
					picture: d.picture ?? null,
					synonyms: d.synonyms.slice(0, 8),
					tags: d.tags,
					sources: d.sources,
				},
				related: related.slice(0, 24).map((n) => card(n.id, n.data as Anime)),
				similar: {
					judged: similar.judged,
					franchiseSize: similar.franchiseSize,
					results: similar.results
						.slice(0, 12)
						.map((s) => ({ ...card(s.id, s.anime), match: s.jev ?? null })),
				},
			});
		}

		const gm = /^\/api\/graph\/([0-9A-Z]{26})$/.exec(url.pathname);
		if (gm) return json(await expand(db, g, gm[1]!));

		if (url.pathname === '/api/meta') {
			const r = await db.execute("SELECT data FROM nodes WHERE type = 'dataset'");
			const data = r.rows[0]?.data;
			return json(typeof data === 'string' ? JSON.parse(data) : (data ?? null));
		}

		return json({ error: 'not found' }, 404);
	} catch (err) {
		console.error(err);
		return json({ error: 'internal error' }, 500);
	}
}

type Data = Record<string, unknown>;
interface GraphNode {
	id: string;
	type: string;
	label: string;
	thumbnail: string | null;
	score: number | null;
	year: number | null;
}

const toGraphNode = (n: { id: string; type: string; data: unknown }): GraphNode => {
	const d = n.data as Data;
	return {
		id: n.id,
		type: n.type,
		label: String(d.title ?? d.name ?? n.type),
		thumbnail: (d.thumbnail as string) ?? null,
		score: (d.score as number) ?? null,
		year: (d.year as number) ?? null,
	};
};

/**
 * One step of the explorer: a node plus a capped slice of its neighbours. An anime brings its
 * franchise (`relatedTo`, both ways), studios, producers and its rarest tags; a studio, producer
 * or tag brings its best-scored titles. Caps keep a tag like "action" (20k titles) to a handful.
 */
async function expand(db: DbClient, g: Graph<typeof animeSchema>, id: string) {
	const node = await g.getNode(id);
	if (!node) return { center: null, nodes: [], links: [] };
	const nodes: GraphNode[] = [toGraphNode(node)];
	const links: Array<{ source: string; target: string; rel: string }> = [];
	const add = (n: { id: string; type: string; data: unknown }, rel: string, out: boolean) => {
		nodes.push(toGraphNode(n));
		links.push(out ? { source: id, target: n.id, rel } : { source: n.id, target: id, rel });
	};

	if (node.type === 'anime') {
		const [out, back, studios, producers] = await Promise.all([
			g.neighbors(id, { rels: ['relatedTo'], direction: 'forward' }),
			g.neighbors(id, { rels: ['relatedTo'], direction: 'reverse' }),
			g.neighbors(id, { rels: ['animatedBy'], direction: 'forward' }),
			g.neighbors(id, { rels: ['producedBy'], direction: 'forward' }),
		]);
		const seen = new Set<string>();
		for (const n of [...out, ...back].slice(0, 40)) {
			if (seen.has(n.id)) continue;
			seen.add(n.id);
			add(n, 'relatedTo', true);
		}
		for (const n of studios) add(n, 'animatedBy', true);
		for (const n of producers.slice(0, 6)) add(n, 'producedBy', true);
		// The rarest tags say the most about a title; under 20 uses they are mostly cleanup noise.
		const tags = (
			await db.execute({
				sql: `SELECT t.dst AS id, count(*) AS n FROM edges t
				      WHERE t.rel = 'taggedWith'
				        AND t.dst IN (SELECT dst FROM edges WHERE rel = 'taggedWith' AND src = ?)
				      GROUP BY t.dst HAVING count(*) >= 20 ORDER BY n ASC LIMIT 16`,
				args: [id],
			})
		).rows.map((r) => String(r.id));
		let kept = 0;
		for (const tagId of tags) {
			const t = await g.getNode(tagId);
			// AniDB's maintenance tags ("medieval -- to be split and deleted") are not descriptive.
			if (!t || String((t.data as Data).name).includes('--')) continue;
			add(t, 'taggedWith', true);
			if (++kept === 8) break;
		}
	} else {
		const rel =
			node.type === 'studio'
				? 'animatedBy'
				: node.type === 'producer'
					? 'producedBy'
					: 'taggedWith';
		const page = await g.neighborsPage(id, { rels: [rel], direction: 'reverse', limit: 500 });
		const best = page.rows
			.filter((n) => n.type === 'anime')
			.sort(
				(a, b) =>
					(((b.data as Data).score as number) ?? 0) - (((a.data as Data).score as number) ?? 0),
			)
			.slice(0, 30);
		for (const n of best) add(n, rel, false);
	}
	return { center: id, nodes, links };
}
