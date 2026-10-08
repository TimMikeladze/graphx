/**
 * The Podcast Atlas API — read-only routes the `web/` app reads, mounted at `/atlas` by `server.ts`.
 *
 *   GET /atlas/config                            tenant + project ids (for the admin TimelineBar)
 *   GET /atlas/overview?podcast&asOf             shows, regulars, crossovers, latest, top sponsors
 *   GET /atlas/search?q&podcast&asOf             hybrid search over every node type
 *   GET /atlas/node/:id?podcast&asOf             one node with everything around it, shaped per type
 *   GET /atlas/slice?focus&depth&sponsors&podcast&asOf   a GraphSlice for the admin canvas
 *   GET /atlas/path?from&to&podcast&asOf         the shortest chain between two nodes, and its slice
 *
 * Every route reads a snapshot of the graph as of `asOf` (live when absent): all nodes and edges,
 * held in memory. A few thousand nodes and edges is small enough that a snapshot is cheaper than
 * any query plan, and every route then answers from the same consistent view. `podcast` narrows
 * the snapshot to one show: its episodes, and the people, topics and sponsors they touch.
 */
import { type DbClient, type Embedder, Graph } from 'graphx';
import { Hono } from 'hono';
import { type EpisodeData, podcastSchema } from './graphx.config.ts';

export type NodeType = 'podcast' | 'episode' | 'person' | 'topic' | 'sponsor' | 'dataset';

export interface SnapNode {
	id: string;
	type: NodeType;
	data: Record<string, unknown>;
}

export interface SnapEdge {
	id: string;
	rel: string;
	src: string;
	dst: string;
	weight: number;
	data: Record<string, unknown>;
}

export interface Snapshot {
	nodes: Map<string, SnapNode>;
	edges: SnapEdge[];
	/** Undirected adjacency: node id → the edges touching it. */
	adj: Map<string, SnapEdge[]>;
	/** Podcast key → its node's data, for episode captions and pictures. */
	shows: Map<string, { name: string; short: string; image?: string }>;
}

/** The admin canvas's wire shape (`packages/admin/src/lib/types.ts` `GraphSlice`). */
export interface Slice {
	nodes: Array<{ id: string; type: string; label?: string; image?: string }>;
	links: Array<{ id: string; source: string; target: string; rel: string; weight: number }>;
	truncated: boolean;
}

/** Search lists people before shows before topics before sponsors when names match equally. */
const TYPE_RANK: Record<NodeType, number> = {
	person: 0,
	podcast: 1,
	episode: 2,
	topic: 3,
	sponsor: 4,
	dataset: 5,
};

/**
 * Rels a focus or a path walks. Sponsors join only when asked (BetterHelp alone touches 117
 * episodes), and `episodeOf` never: every episode of a show is one hop from it, so a walk through
 * the show node says nothing.
 */
const WALK_RELS = ['appearedOn', 'mentions', 'about', 'hosts'];

function snapshotOf(nodes: Map<string, SnapNode>, all: SnapEdge[]): Snapshot {
	const edges: SnapEdge[] = [];
	const adj = new Map<string, SnapEdge[]>();
	for (const e of all) {
		// An edge whose endpoint is not in the snapshot is not part of it.
		if (!nodes.has(e.src) || !nodes.has(e.dst)) continue;
		edges.push(e);
		for (const end of [e.src, e.dst]) {
			const list = adj.get(end);
			if (list) list.push(e);
			else adj.set(end, [e]);
		}
	}
	const shows = new Map<string, { name: string; short: string; image?: string }>();
	for (const n of nodes.values()) {
		if (n.type === 'podcast') {
			const d = n.data as { key: string; name: string; short: string; image?: string };
			shows.set(d.key, { name: d.name, short: d.short, image: d.image });
		}
	}
	return { nodes, edges, adj, shows };
}

export async function loadSnapshot(db: DbClient, asOf?: number): Promise<Snapshot> {
	const past = asOf !== undefined;
	const nodeSql = past
		? 'SELECT id, type, data FROM node_versions WHERE valid_from <= ? AND ? < valid_to'
		: 'SELECT id, type, data FROM nodes';
	const edgeSql = past
		? 'SELECT id, rel, src, dst, weight, data FROM edge_versions WHERE valid_from <= ? AND ? < valid_to'
		: 'SELECT id, rel, src, dst, weight, data FROM edges';
	const args = past ? [asOf, asOf] : [];
	const [nr, er] = await Promise.all([
		db.execute({ sql: nodeSql, args }),
		db.execute({ sql: edgeSql, args }),
	]);
	const nodes = new Map<string, SnapNode>();
	for (const r of nr.rows) {
		nodes.set(String(r.id), {
			id: String(r.id),
			type: String(r.type) as NodeType,
			data: JSON.parse(String(r.data)),
		});
	}
	const edges = er.rows.map(
		(r): SnapEdge => ({
			id: String(r.id),
			rel: String(r.rel),
			src: String(r.src),
			dst: String(r.dst),
			weight: Number(r.weight ?? 1),
			data: r.data ? JSON.parse(String(r.data)) : {},
		}),
	);
	return snapshotOf(nodes, edges);
}

/**
 * The snapshot narrowed to one show: its podcast node, its episodes, and every person, topic and
 * sponsor still attached to one of them (or hosting it). A guest of both shows stays, with only
 * this show's appearances.
 */
export function scopeTo(snap: Snapshot, podcast: string): Snapshot {
	const keep = new Map<string, SnapNode>();
	for (const n of snap.nodes.values()) {
		if (n.type === 'episode' && n.data.podcast === podcast) keep.set(n.id, n);
		if (n.type === 'podcast' && n.data.key === podcast) keep.set(n.id, n);
	}
	const anchors = new Set(keep.keys());
	for (const e of snap.edges) {
		for (const [mine, other] of [
			[e.src, e.dst],
			[e.dst, e.src],
		] as const) {
			if (!anchors.has(mine)) continue;
			const n = snap.nodes.get(other) as SnapNode;
			if (n.type !== 'episode' && n.type !== 'podcast') keep.set(other, n);
		}
	}
	const dataset = [...snap.nodes.values()].find((n) => n.type === 'dataset');
	if (dataset) keep.set(dataset.id, dataset);
	return snapshotOf(keep, snap.edges);
}

/** `https://www.youtube.com/watch?v=abc` → the video's medium thumbnail. */
export function thumbnailOf(youtubeUrl: unknown): string | undefined {
	if (typeof youtubeUrl !== 'string') return undefined;
	const id = /[?&]v=([\w-]{6,})/.exec(youtubeUrl)?.[1];
	return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : undefined;
}

/** Short canvas caption: `Lex #252 Elon Musk` for an episode, the name for everything else. */
export function labelOf(snap: Snapshot, n: SnapNode): string {
	if (n.type === 'episode') {
		const d = n.data as EpisodeData;
		const who = d.guests.length ? d.guests.join(' & ') : d.title;
		const show = snap.shows.get(d.podcast)?.short ?? d.podcast;
		return d.number ? `${show} #${d.number} ${who}` : `${show} · ${who}`;
	}
	return String(n.data.name ?? n.type);
}

/** Episodes a node touches over `rels`, oldest first. */
function episodesOf(snap: Snapshot, id: string, rels: string[]): SnapNode[] {
	const out: SnapNode[] = [];
	for (const e of snap.adj.get(id) ?? []) {
		if (!rels.includes(e.rel)) continue;
		const other = snap.nodes.get(e.src === id ? e.dst : e.src);
		if (other?.type === 'episode') out.push(other);
	}
	return out.sort((a, b) => String(a.data.publishedAt).localeCompare(String(b.data.publishedAt)));
}

/** An episode's video thumbnail, else its show's cover art. */
function episodeImage(snap: Snapshot, n: SnapNode): string | undefined {
	return thumbnailOf(n.data.youtubeUrl) ?? snap.shows.get(String(n.data.podcast))?.image;
}

function imageOf(snap: Snapshot, n: SnapNode): string | undefined {
	if (n.type === 'episode') return episodeImage(snap, n);
	if (n.type === 'podcast') return n.data.image as string | undefined;
	if (n.type === 'person') {
		// A person's picture is their latest video thumbnail: it is them, on set. Cover art is not.
		const own = episodesOf(snap, n.id, ['appearedOn']);
		return own
			.map((e) => thumbnailOf(e.data.youtubeUrl))
			.filter(Boolean)
			.at(-1);
	}
	return undefined;
}

function sliceNode(snap: Snapshot, n: SnapNode): Slice['nodes'][number] {
	return { id: n.id, type: n.type, label: labelOf(snap, n), image: imageOf(snap, n) };
}

/** The slice over a node set: those nodes, and every snapshot edge among them on `rels`. */
export function sliceOf(snap: Snapshot, ids: Set<string>, rels?: string[]): Slice {
	const nodes = [...ids].flatMap((id) => {
		const n = snap.nodes.get(id);
		return n && n.type !== 'dataset' ? [sliceNode(snap, n)] : [];
	});
	const keep = new Set(nodes.map((n) => n.id));
	const links = snap.edges
		.filter((e) => keep.has(e.src) && keep.has(e.dst) && (!rels || rels.includes(e.rel)))
		.map((e) => ({ id: e.id, source: e.src, target: e.dst, rel: e.rel, weight: e.weight }));
	return { nodes, links, truncated: false };
}

/**
 * Breadth-first neighborhood of `focus` out to `depth` hops over `rels`, both directions. Capped at
 * `max` nodes, nearest first, so a hub topic cannot drag in half the graph.
 */
export function neighborhood(
	snap: Snapshot,
	focus: string,
	depth: number,
	rels: string[],
	max = 800,
): { ids: Set<string>; truncated: boolean } {
	const ids = new Set([focus]);
	let frontier = [focus];
	for (let hop = 0; hop < depth && frontier.length; hop++) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const e of snap.adj.get(id) ?? []) {
				if (!rels.includes(e.rel)) continue;
				const other = e.src === id ? e.dst : e.src;
				if (ids.has(other)) continue;
				if (ids.size >= max) return { ids, truncated: true };
				ids.add(other);
				next.push(other);
			}
		}
		frontier = next;
	}
	return { ids, truncated: false };
}

/** Shortest undirected path over `rels`, as node ids from `from` to `to`; null when unconnected. */
export function shortestPath(
	snap: Snapshot,
	from: string,
	to: string,
	rels = WALK_RELS,
): string[] | null {
	if (!snap.nodes.has(from) || !snap.nodes.has(to)) return null;
	const prev = new Map<string, string | null>([[from, null]]);
	let frontier = [from];
	while (frontier.length && !prev.has(to)) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const e of snap.adj.get(id) ?? []) {
				if (!rels.includes(e.rel)) continue;
				const other = e.src === id ? e.dst : e.src;
				if (prev.has(other)) continue;
				prev.set(other, id);
				next.push(other);
			}
		}
		frontier = next;
	}
	if (!prev.has(to)) return null;
	const path: string[] = [];
	for (let id: string | null = to; id; id = prev.get(id) ?? null) path.unshift(id);
	return path;
}

/** A compact row for lists: what the app shows for a node anywhere but its own panel. */
export interface Brief {
	id: string;
	type: NodeType;
	label: string;
	image?: string;
	podcast?: string;
	title?: string;
	number?: number;
	publishedAt?: string;
	guests?: string[];
	tagline?: string;
}

function brief(snap: Snapshot, n: SnapNode): Brief {
	const base = { id: n.id, type: n.type, label: labelOf(snap, n) };
	if (n.type === 'episode') {
		const d = n.data as EpisodeData;
		return {
			...base,
			podcast: d.podcast,
			title: d.title,
			number: d.number,
			publishedAt: d.publishedAt,
			guests: d.guests,
			image: episodeImage(snap, n),
		};
	}
	if (n.type === 'person') {
		return { ...base, tagline: n.data.tagline as string | undefined, image: imageOf(snap, n) };
	}
	if (n.type === 'podcast') {
		return {
			...base,
			podcast: String(n.data.key),
			tagline: `hosted by ${n.data.host}`,
			image: imageOf(snap, n),
		};
	}
	return base;
}

/** People ranked by `rel` edges into the snapshot's episodes: the most frequent guests. */
function topPeople(snap: Snapshot, rel: 'appearedOn' | 'mentions', within?: Set<string>) {
	const counts = new Map<string, number>();
	for (const e of snap.edges) {
		if (e.rel !== rel) continue;
		const [person, episode] = rel === 'appearedOn' ? [e.src, e.dst] : [e.dst, e.src];
		if (within && !within.has(episode)) continue;
		if (snap.nodes.get(person)?.type === 'person')
			counts.set(person, (counts.get(person) ?? 0) + 1);
	}
	return [...counts]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 12)
		.map(([id, count]) => ({ ...brief(snap, snap.nodes.get(id) as SnapNode), count }));
}

/** The shows a person appeared on or hosts, by short name (`Lex`, `Mindscape`). */
function showsOf(snap: Snapshot, personId: string): string[] {
	const keys = new Set<string>();
	for (const e of snap.adj.get(personId) ?? []) {
		if (e.rel === 'appearedOn') keys.add(String(snap.nodes.get(e.dst)?.data.podcast));
		if (e.rel === 'hosts') keys.add(String(snap.nodes.get(e.dst)?.data.key));
	}
	return [...keys].map((k) => snap.shows.get(k)?.short ?? k);
}

/** Everything the detail panel shows for one node, shaped by its type. */
export function detailOf(snap: Snapshot, id: string) {
	const n = snap.nodes.get(id);
	if (!n) return null;
	const around = (rel: string, dir: 'out' | 'in') =>
		(snap.adj.get(id) ?? [])
			.filter((e) => e.rel === rel && (dir === 'out' ? e.src === id : e.dst === id))
			.map((e) => ({ edge: e, node: snap.nodes.get(dir === 'out' ? e.dst : e.src) as SnapNode }))
			.filter((x) => x.node);
	const byDate = <T extends { node: SnapNode }>(xs: T[]) =>
		xs.sort((a, b) =>
			String(a.node.data.publishedAt).localeCompare(String(b.node.data.publishedAt)),
		);

	if (n.type === 'episode') {
		return {
			...brief(snap, n),
			data: n.data,
			podcastNode: around('episodeOf', 'out').map((x) => brief(snap, x.node))[0],
			guests: around('appearedOn', 'in').map((x) => brief(snap, x.node)),
			topics: around('about', 'out').map((x) => brief(snap, x.node)),
			sponsors: around('sponsoredBy', 'out').map((x) => brief(snap, x.node)),
			mentions: around('mentions', 'out').map((x) => ({
				...brief(snap, x.node),
				chapter: String(x.edge.data.chapter),
				startSec: Number(x.edge.data.startSec),
			})),
		};
	}
	if (n.type === 'person') {
		return {
			...brief(snap, n),
			data: n.data,
			hosts: around('hosts', 'out').map((x) => brief(snap, x.node)),
			shows: showsOf(snap, id),
			episodes: byDate(around('appearedOn', 'out')).map((x) => brief(snap, x.node)),
			mentionedIn: byDate(around('mentions', 'in')).map((x) => ({
				...brief(snap, x.node),
				chapter: String(x.edge.data.chapter),
				startSec: Number(x.edge.data.startSec),
			})),
		};
	}
	if (n.type === 'podcast') {
		const episodes = byDate(around('episodeOf', 'in')).map((x) => x.node);
		return {
			...brief(snap, n),
			data: n.data,
			hostedBy: around('hosts', 'in').map((x) => brief(snap, x.node)),
			count: episodes.length,
			first: episodes[0]?.data.publishedAt as string | undefined,
			last: episodes.at(-1)?.data.publishedAt as string | undefined,
			regulars: topPeople(snap, 'appearedOn', new Set(episodes.map((e) => e.id))).filter(
				(p) => p.count > 1,
			),
			latest: episodes
				.slice(-20)
				.reverse()
				.map((e) => brief(snap, e)),
		};
	}
	const rel = n.type === 'topic' ? 'about' : 'sponsoredBy';
	const episodes = byDate(around(rel, 'in')).map((x) => brief(snap, x.node));
	return {
		...brief(snap, n),
		data: n.data,
		episodes,
		first: episodes[0]?.publishedAt,
		last: episodes.at(-1)?.publishedAt,
	};
}

/** The landing lists: the shows, who came back most, who crossed over, what aired last, who paid. */
export function overviewOf(snap: Snapshot) {
	const degree = (type: string, rel: string, dir: 'src' | 'dst') => {
		const counts = new Map<string, number>();
		for (const e of snap.edges) {
			if (e.rel !== rel) continue;
			const id = e[dir];
			if (snap.nodes.get(id)?.type === type) counts.set(id, (counts.get(id) ?? 0) + 1);
		}
		return [...counts]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([id, count]) => ({ ...brief(snap, snap.nodes.get(id) as SnapNode), count }));
	};
	const all = [...snap.nodes.values()];
	const latest = all
		.filter((n) => n.type === 'episode')
		.sort((a, b) => String(b.data.publishedAt).localeCompare(String(a.data.publishedAt)))
		.slice(0, 12)
		.map((n) => brief(snap, n));
	const count = (type: string) => all.filter((n) => n.type === type).length;
	// People heard on more than one show, as a guest or a host: where the shows meet.
	const crossovers = all
		.filter((n) => n.type === 'person')
		.map((n) => ({ n, shows: showsOf(snap, n.id) }))
		.filter((x) => x.shows.length > 1)
		.map((x) => ({
			...brief(snap, x.n),
			count: episodesOf(snap, x.n.id, ['appearedOn']).length,
			shows: x.shows,
		}))
		.sort((a, b) => b.count - a.count);
	return {
		counts: {
			podcasts: count('podcast'),
			episodes: count('episode'),
			people: count('person'),
			topics: count('topic'),
			sponsors: count('sponsor'),
		},
		podcasts: degree('podcast', 'episodeOf', 'dst'),
		regulars: topPeople(snap, 'appearedOn'),
		mentioned: topPeople(snap, 'mentions'),
		crossovers,
		topics: degree('topic', 'about', 'dst'),
		sponsors: degree('sponsor', 'sponsoredBy', 'dst'),
		latest,
	};
}

/**
 * The Hono app. `asOf` snapshots are cached (the scrubber revisits the same instants); the live
 * one is cached for the process, because the server is the only writer and syncs before serving.
 */
export function createAtlasApi(opts: {
	db: DbClient;
	embedder: Embedder;
	tenant: string;
	project: string;
}): Hono {
	const { db } = opts;
	const g = new Graph(db, podcastSchema, { embedder: opts.embedder });
	const cache = new Map<string, Promise<Snapshot>>();
	const cached = (key: string, load: () => Promise<Snapshot>) => {
		let hit = cache.get(key);
		if (!hit) {
			if (cache.size > 64) cache.delete(cache.keys().next().value as string);
			hit = load();
			cache.set(key, hit);
		}
		return hit;
	};
	const full = (asOf?: number) =>
		cached(asOf === undefined ? 'live' : String(asOf), () => loadSnapshot(db, asOf));
	const snapshot = (c: { req: { query: (k: string) => string | undefined } }) => {
		const v = c.req.query('asOf');
		const t = v ? Number(v) : Number.NaN;
		const asOf = Number.isFinite(t) ? t : undefined;
		const podcast = c.req.query('podcast') || undefined;
		return podcast
			? cached(`${podcast}@${asOf ?? 'live'}`, async () => scopeTo(await full(asOf), podcast))
			: full(asOf);
	};
	const asOfOf = (v: string | undefined) => {
		const t = v ? Number(v) : Number.NaN;
		return Number.isFinite(t) ? t : undefined;
	};

	const app = new Hono();
	app.get('/config', (c) => c.json({ tenant: opts.tenant, project: opts.project }));

	app.get('/overview', async (c) => c.json(overviewOf(await snapshot(c))));

	app.get('/search', async (c) => {
		const q = (c.req.query('q') ?? '').trim();
		const snap = await snapshot(c);
		if (!q) return c.json({ results: [] });
		// Names first: a person, show, topic or sponsor whose name contains the query — people first,
		// then the shortest name — so "elon" puts Elon Musk above every episode that mentions him.
		const needle = q.toLowerCase();
		const named = [...snap.nodes.values()]
			.filter((n) => n.type !== 'episode' && n.type !== 'dataset')
			.filter((n) => String(n.data.name).toLowerCase().includes(needle))
			.sort(
				(a, b) =>
					TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
					String(a.data.name).length - String(b.data.name).length,
			)
			.slice(0, 8);
		const hits = await g.hybridRetrieve({
			query: q,
			k: 30,
			maxDepth: 0,
			asOf: asOfOf(c.req.query('asOf')),
		});
		const seen = new Set(named.map((n) => n.id));
		const ranked = hits.flatMap((h) => {
			// Not in the (possibly one-show) snapshot ⇒ not a result.
			const n = snap.nodes.get(h.id);
			if (!n || n.type === 'dataset' || seen.has(h.id)) return [];
			seen.add(h.id);
			return [{ ...brief(snap, n), score: h.score }];
		});
		return c.json({ results: [...named.map((n) => brief(snap, n)), ...ranked].slice(0, 24) });
	});

	app.get('/node/:id', async (c) => {
		const detail = detailOf(await snapshot(c), c.req.param('id'));
		return detail ? c.json(detail) : c.json({ error: 'not found at this instant' }, 404);
	});

	app.get('/slice', async (c) => {
		const snap = await snapshot(c);
		const focus = c.req.query('focus');
		const sponsors = c.req.query('sponsors') === '1';
		const rels = sponsors ? [...WALK_RELS, 'sponsoredBy'] : WALK_RELS;
		if (!focus) {
			// Everything, with each show's episodes tied to its podcast node so every show reads as its
			// own cluster, bridged by the people and topics they share. Sponsors only on request: 135
			// hubs over 1,824 edges pull every Lex episode into one knot. Topics only when two or more
			// episodes share them: a topic one title used is a leaf that says nothing about how
			// conversations connect, and ~1,200 of them turn the canvas into a uniform ball.
			const shared = (n: SnapNode) =>
				(snap.adj.get(n.id) ?? []).filter((e) => e.rel === 'about').length >= 2;
			const ids = new Set(
				[...snap.nodes.values()]
					.filter((n) => n.type !== 'dataset' && (sponsors || n.type !== 'sponsor'))
					.filter((n) => n.type !== 'topic' || shared(n))
					.map((n) => n.id),
			);
			return c.json(sliceOf(snap, ids, [...rels, 'episodeOf']));
		}
		const node = snap.nodes.get(focus);
		if (!node) return c.json({ error: 'not found at this instant' }, 404);
		const depth = Math.min(3, Math.max(1, Number(c.req.query('depth') ?? 2)));
		// A sponsor's neighborhood is its episodes, a show's its episodes: each walks its own rel.
		const own =
			node.type === 'sponsor' ? 'sponsoredBy' : node.type === 'podcast' ? 'episodeOf' : undefined;
		const walk = own && !rels.includes(own) ? [...rels, own] : rels;
		const { ids, truncated } = neighborhood(snap, focus, node.type === 'podcast' ? 1 : depth, walk);
		return c.json({ ...sliceOf(snap, ids, walk), truncated });
	});

	app.get('/path', async (c) => {
		const snap = await snapshot(c);
		const from = c.req.query('from') ?? '';
		const to = c.req.query('to') ?? '';
		const path = shortestPath(snap, from, to);
		if (!path) return c.json({ path: null, slice: { nodes: [], links: [], truncated: false } });
		// Only the edges along the path, so the chain reads as a chain.
		const steps = new Set(path.slice(1).map((id, i) => [path[i], id].sort().join('|')));
		const slice = sliceOf(snap, new Set(path));
		slice.links = slice.links.filter((l) => steps.has([l.source, l.target].sort().join('|')));
		return c.json({ path: path.map((id) => brief(snap, snap.nodes.get(id) as SnapNode)), slice });
	});

	return app;
}
