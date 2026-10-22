export type Day = 'weekday' | 'saturday' | 'sunday';
export const DAYS: Day[] = ['weekday', 'saturday', 'sunday'];

export interface Meta {
	tenant: string;
	project: string;
	user: string;
	feed: { publisher: string; version: string; start: string; end: string };
	dates: Record<Day, string>;
	counts: { routes: number; stops: number; patterns: number; trips: number };
}
export interface RouteRow {
	id: string;
	gtfsId: string;
	short: string;
	long: string;
	desc: string;
	agency: string;
	mode: string;
	color: string;
}
export interface StopRow {
	id: string;
	gtfsId: string;
	code: string;
	name: string;
	lat: number;
	lng: number;
}
export interface PatternRow {
	id: string;
	key: string;
	route: string;
	direction: number;
	headsign: string;
	coords: [number, number][];
	cum: number[];
	stopDist: number[];
	offsets: number[];
	/** [start, duration, dayMask] — bit 0 weekday, 1 saturday, 2 sunday */
	trips: Array<[number, number, number]>;
}
export interface Network {
	routes: RouteRow[];
	stops: StopRow[];
	patterns: PatternRow[];
}
export interface RouteDetail {
	route: RouteRow;
	patterns: Array<{
		id: string;
		key: string;
		direction: number;
		headsign: string;
		lengthM: number;
		offsets: number[];
		stops: Array<{ gtfsId: string; name: string }>;
	}>;
	trips: Array<{
		id: string;
		gtfsId: string;
		pattern: string;
		direction: number;
		headsign: string;
		days: Day[];
		start: number;
		duration: number;
		times: number[];
	}>;
	hourly: Array<{ day: Day; direction: number; hour: number; trips: number }>;
}
export interface StopDetail {
	stop: StopRow;
	routes: Array<{ gtfsId: string; short: string; color?: string }>;
	departures: Array<{ route: string; short: string; headsign: string; time: number }>;
}
export interface Scenario {
	id: string;
	title: string;
	namespace: string;
	project: string;
	status: 'forking' | 'ready' | 'failed';
	edits: Array<Record<string, unknown> & { op: string; result?: string }>;
}
export interface Compare {
	days: Record<
		Day,
		{
			before: { trips: number; revenueHours: number; stopsServed: number };
			after: { trips: number; revenueHours: number; stopsServed: number };
		}
	>;
	stopsLost: Record<Day, Array<{ gtfsId: string; name: string }>>;
	stopsGained: Record<Day, number>;
	routes: Array<{ route: string; short: string; day: Day; before: number; after: number }>;
	versions: { nodes: number; edges: number };
}
export interface Vehicle {
	id: string;
	route: string;
	trip: string;
	lat: number;
	lng: number;
	stop: string;
	status: string;
	timestamp: number;
}

export async function get<T>(path: string): Promise<T> {
	const res = await fetch(path);
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json() as Promise<T>;
}
export async function post<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as T & { error?: string };
	if (!res.ok) throw new Error(json.error ?? String(res.status));
	return json;
}
export const withProject = (path: string, project: string | null) =>
	project ? `${path}${path.includes('?') ? '&' : '?'}project=${project}` : path;

/** 27000 → "07:30". Service days run past midnight, so 25:10 stays 25:10. */
export const clock = (sec: number) =>
	`${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
export const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export type NodeType = 'route' | 'stop' | 'pattern' | 'trip' | 'scenario';
export interface GraphSchemaCounts {
	nodes: Array<{ type: NodeType; count: number }>;
	edges: Array<{ rel: string; from: NodeType; to: NodeType; count: number }>;
}
export interface GraphNode {
	id: string;
	type: NodeType;
	label: string;
	hop: number;
	pos: [number, number] | null;
	group?: {
		key: string;
		parent: string;
		rel: string;
		dir: 'out' | 'in';
		count: number;
		expandable: boolean;
	};
}
export interface GraphEdge {
	id: string;
	rel: string;
	src: string;
	dst: string;
	weight: number;
	data: unknown;
}
export interface Neighbourhood {
	focus: GraphNode & { data: Record<string, unknown> };
	history: Array<{
		validFrom: number;
		validTo: number;
		recordedFrom: number;
		recordedTo: number;
		current: boolean;
		data: Record<string, unknown>;
	}>;
	neighbours: Array<{
		rel: string;
		dir: 'out' | 'in';
		count: number;
		items: Array<{ id: string; type: NodeType; label: string; edge: GraphEdge }>;
	}>;
	nodes: GraphNode[];
	edges: GraphEdge[];
}
/** `[src stop id, dst stop id, scheduled seconds, trips]` */
export type Hop = [string, string, number, number];
