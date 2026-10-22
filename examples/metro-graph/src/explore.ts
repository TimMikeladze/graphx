import { type EdgeRecord, type Graph, history, slicePredicate } from 'graphx';
import { type Schema, schema } from '../schema.ts';
import { allEdges, type View } from './view.ts';

/**
 * The graph viewer's reads: per-type and per-rel counts, node search, and the neighbourhood of
 * one node with big groups collapsed so a pattern with 500 trips stays a single "500 trips" node.
 */

export type NodeType = keyof Schema['nodes'];
type Pos = [number, number];

export interface ExploreNode {
	id: string;
	type: NodeType;
	label: string;
	hop: number;
	/** [lng, lat]. Stops at their coordinates; patterns, routes and trips at a pattern's midpoint. */
	pos: Pos | null;
	/** Set on a collapsed group: its members are `count` nodes of `type` reached over `rel`. */
	group?: {
		key: string;
		parent: string;
		rel: string;
		dir: Dir;
		count: number;
		expandable: boolean;
	};
}
export interface ExploreEdge {
	id: string;
	rel: string;
	src: string;
	dst: string;
	weight: number;
	data: unknown;
}
type Dir = 'out' | 'in';

/** Hop-1 groups larger than this collapse; hop-2 groups use the smaller limit. */
export const GROUP_LIMIT = 20;
const HOP2_GROUP_LIMIT = 6;
/** Members shown when a collapsed group is expanded; the rest stay a "N more" node. */
export const EXPAND_LIMIT = 80;
/** Node cap for one neighbourhood; groups past it collapse whatever their size. */
export const MAX_NODES = 160;
/** Hop-1 nodes whose own edges are read for depth 2. */
const HOP2_PARENTS = 40;

/** Every node of the four feed types by graphx id, built once per view. */
const indexes = new WeakMap<View, Map<string, { type: NodeType; data: Record<string, unknown> }>>();
function byId(v: View) {
	let m = indexes.get(v);
	if (!m) {
		m = new Map();
		for (const r of v.routes) m.set(r.id, { type: 'route', data: r.data });
		for (const s of v.stops) m.set(s.id, { type: 'stop', data: s.data });
		for (const p of v.patterns) m.set(p.id, { type: 'pattern', data: p.data });
		for (const t of v.trips) m.set(t.id, { type: 'trip', data: t.data });
		indexes.set(v, m);
	}
	return m;
}

const clock = (sec: number) =>
	`${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

export function label(v: View, type: string, data: Record<string, unknown>): string {
	const short = (route: unknown) => v.route.get(String(route))?.data.short ?? String(route);
	switch (type) {
		case 'route':
			return `Route ${data.short}`;
		case 'stop':
			return String(data.name);
		case 'pattern':
			return `${short(data.route)} to ${data.headsign}, ${(data.stops as string[]).length} stops`;
		case 'trip':
			return `${clock(Number(data.start))} ${short(data.route)} to ${data.headsign}`;
		default:
			return String(data.title ?? type);
	}
}

const mid = (coords: Pos[]) => coords[Math.floor(coords.length / 2)] ?? null;

export function position(v: View, type: string, data: Record<string, unknown>): Pos | null {
	if (type === 'stop') return [Number(data.lng), Number(data.lat)];
	if (type === 'pattern') return mid(data.coords as Pos[]);
	if (type === 'trip') {
		const p = v.pattern.get(String(data.pattern));
		return p ? mid(p.data.coords) : null;
	}
	if (type === 'route') {
		// The middle of its longest pattern, so the anchor sits on the line.
		const longest = v.patterns
			.filter((p) => p.data.route === data.gtfsId)
			.sort((a, b) => b.data.lengthM - a.data.lengthM)[0];
		return longest ? mid(longest.data.coords) : null;
	}
	return null;
}

/** Live node count per type and edge count per rel, alongside the schema's endpoints. */
export async function counts(g: Graph<Schema>) {
	const n = slicePredicate('nv', {});
	const e = slicePredicate('ev', {});
	const [nodes, edges] = await Promise.all([
		g.raw.execute({
			sql: `SELECT nv.type AS k, COUNT(*) AS c FROM node_versions nv WHERE ${n.sql} GROUP BY nv.type`,
			args: n.args,
		}),
		g.raw.execute({
			sql: `SELECT ev.rel AS k, COUNT(*) AS c FROM edge_versions ev WHERE ${e.sql} GROUP BY ev.rel`,
			args: e.args,
		}),
	]);
	const of = (rows: typeof nodes.rows) => new Map(rows.map((r) => [String(r.k), Number(r.c)]));
	const nc = of(nodes.rows);
	const ec = of(edges.rows);
	return {
		nodes: Object.keys(schema.nodes).map((type) => ({ type, count: nc.get(type) ?? 0 })),
		edges: Object.entries(schema.edges).map(([rel, def]) => ({
			rel,
			from: def.from,
			to: def.to,
			count: ec.get(rel) ?? 0,
		})),
	};
}

/** Routes and stops by name or number, patterns by headsign or key, trips by GTFS id. */
export function search(v: View, q: string, type: string | undefined, limit = 40) {
	const needle = q.trim().toLowerCase();
	const out: Array<{ id: string; type: NodeType; label: string }> = [];
	const scan = <T extends { id: string; data: Record<string, unknown> }>(
		t: NodeType,
		rows: T[],
		text: (d: T['data']) => string,
	) => {
		if (type && type !== t) return;
		for (const r of rows) {
			if (out.length >= limit) return;
			if (!needle || text(r.data).toLowerCase().includes(needle))
				out.push({ id: r.id, type: t, label: label(v, t, r.data) });
		}
	};
	scan('route', v.routes, (d) => `${d.short} ${d.long} ${d.desc} ${d.gtfsId}`);
	scan('stop', v.stops, (d) => `${d.name} ${d.code} ${d.gtfsId}`);
	scan('pattern', v.patterns, (d) => `${d.key} ${d.headsign}`);
	scan('trip', v.trips, (d) => d.gtfsId);
	return out;
}

/**
 * The focus node, its version history, every hop-1 neighbour grouped by rel and direction, and a
 * capped node-link neighbourhood to `depth` 1 or 2. `expand` lists group keys
 * (`<parent>:<rel>:<dir>`) to show member by member.
 */
export async function neighbourhood(
	g: Graph<Schema>,
	v: View,
	id: string,
	depth: number,
	expand: Set<string>,
) {
	const focus = await g.getNode(id);
	if (!focus) return null;
	const index = byId(v);
	const info = (nid: string) => index.get(nid);
	const nodeOf = (nid: string, hop: number): ExploreNode | null => {
		const x = info(nid);
		if (!x) return null;
		return {
			id: nid,
			type: x.type,
			label: label(v, x.type, x.data),
			hop,
			pos: position(v, x.type, x.data),
		};
	};

	const nodes = new Map<string, ExploreNode>();
	const edges = new Map<string, ExploreEdge>();
	const focusData = focus.data as Record<string, unknown>;
	nodes.set(id, {
		id,
		type: focus.type as NodeType,
		label: label(v, focus.type, focusData),
		hop: 0,
		pos: position(v, focus.type, focusData),
	});

	const edgesOf = async (nid: string) => {
		const [out, inn] = await Promise.all([allEdges(g, { src: nid }), allEdges(g, { dst: nid })]);
		return { out, in: inn };
	};
	const toEdge = (e: EdgeRecord): ExploreEdge => ({
		id: e.id,
		rel: e.rel,
		src: e.src,
		dst: e.dst,
		weight: e.weight,
		data: e.data,
	});
	/** Order members so expanded trips read in time order and stops in stop order. */
	const sortKey = (e: { rel: string; data: unknown }, other: string) => {
		const x = info(other);
		if (e.rel === 'calls') return Number((e.data as { seq?: number })?.seq ?? 0);
		if (x?.type === 'trip') return Number(x.data.start);
		return 0;
	};

	// Group a node's edges by (rel, direction) and place them: members individually, or one group.
	const place = (parent: string, list: { out: EdgeRecord[]; in: EdgeRecord[] }, hop: number) => {
		const placed: string[] = [];
		for (const dir of ['out', 'in'] as const) {
			const byRel = new Map<string, EdgeRecord[]>();
			for (const e of list[dir]) {
				if (!byRel.has(e.rel)) byRel.set(e.rel, []);
				byRel.get(e.rel)!.push(e);
			}
			for (const [rel, es] of byRel) {
				const other = (e: EdgeRecord) => (dir === 'out' ? e.dst : e.src);
				// Edges to nodes already drawn are kept as edges and never collapse.
				const known = es.filter((e) => nodes.has(other(e)));
				for (const e of known) edges.set(e.id, toEdge(e));
				const fresh = es
					.filter((e) => !nodes.has(other(e)) && info(other(e)))
					.sort((a, b) => sortKey(a, other(a)) - sortKey(b, other(b)));
				if (!fresh.length) continue;
				const key = `${parent}:${rel}:${dir}`;
				const limit = hop === 1 ? GROUP_LIMIT : HOP2_GROUP_LIMIT;
				const room = MAX_NODES - nodes.size;
				let shown = fresh;
				if (expand.has(key)) shown = fresh.slice(0, Math.min(EXPAND_LIMIT, Math.max(room - 1, 0)));
				else if (fresh.length > limit || fresh.length > room) shown = [];
				for (const e of shown) {
					const n = nodeOf(other(e), hop)!;
					nodes.set(n.id, n);
					edges.set(e.id, toEdge(e));
					placed.push(n.id);
				}
				const rest = fresh.slice(shown.length);
				if (!rest.length) continue;
				const type = info(other(rest[0]!))!.type;
				const pts = rest.map((e) => nodeOf(other(e), hop)?.pos).filter((p): p is Pos => !!p);
				const gid = `group:${key}`;
				nodes.set(gid, {
					id: gid,
					type,
					label: `${shown.length ? `${rest.length} more` : rest.length} ${type}s`,
					hop,
					pos: pts.length
						? [
								pts.reduce((s, p) => s + p[0], 0) / pts.length,
								pts.reduce((s, p) => s + p[1], 0) / pts.length,
							]
						: null,
					group: { key, parent, rel, dir, count: rest.length, expandable: !shown.length },
				});
				edges.set(gid, {
					id: gid,
					rel,
					src: dir === 'out' ? parent : gid,
					dst: dir === 'out' ? gid : parent,
					weight: rest.length,
					data: null,
				});
			}
		}
		return placed;
	};

	const own = await edgesOf(id);
	const hop1 = place(id, own, 1);
	if (depth >= 2) {
		const parents = hop1.slice(0, HOP2_PARENTS);
		const lists = await Promise.all(parents.map(edgesOf));
		for (const [i, p] of parents.entries()) place(p, lists[i]!, 2);
	}

	// The explorer's list: every hop-1 neighbour, uncapped, grouped by rel and direction.
	const groups = new Map<
		string,
		{
			rel: string;
			dir: Dir;
			items: Array<{ id: string; type: NodeType; label: string; edge: ExploreEdge }>;
		}
	>();
	for (const dir of ['out', 'in'] as const)
		for (const e of own[dir]) {
			const other = dir === 'out' ? e.dst : e.src;
			const x =
				info(other) ??
				(other === id ? { type: focus.type as NodeType, data: focusData } : undefined);
			if (!x) continue;
			const k = `${e.rel}:${dir}`;
			if (!groups.has(k)) groups.set(k, { rel: e.rel, dir, items: [] });
			groups
				.get(k)!
				.items.push({ id: other, type: x.type, label: label(v, x.type, x.data), edge: toEdge(e) });
		}
	for (const gr of groups.values())
		gr.items.sort(
			(a, b) => sortKey(a.edge, a.id) - sortKey(b.edge, b.id) || a.label.localeCompare(b.label),
		);

	const versions = (await history(g.raw, id)).map((r) => ({
		validFrom: Number(r.valid_from),
		validTo: Number(r.valid_to),
		recordedFrom: Number(r.recorded_from),
		recordedTo: Number(r.recorded_to),
		current: r.current as boolean,
		data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
	}));

	return {
		focus: { ...nodes.get(id)!, data: focusData },
		history: versions,
		neighbours: [...groups.values()].map((gr) => ({ ...gr, count: gr.items.length })),
		nodes: [...nodes.values()],
		edges: [...edges.values()],
	};
}

/** Every live `hop` edge as `[src stop id, dst stop id, seconds, trips]`, for the network overlay. */
export async function hops(g: Graph<Schema>) {
	return (await allEdges(g, { rel: 'hop' })).map(
		(e) => [e.src, e.dst, e.weight, Number((e.data as { trips?: number })?.trips ?? 0)] as const,
	);
}
