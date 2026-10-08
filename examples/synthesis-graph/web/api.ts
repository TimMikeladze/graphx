// Types only from the server side — the browser bundle carries no graphx runtime.
import type { Graph, Objective, Plan } from '../src/route.ts';

export type { Graph, Objective, Plan };
export type Route = 'Boots' | 'BHC' | 'Flow';

export interface Meta {
	firstYear: number;
	lastYear: number;
	events: Array<{ year: number; label: string }>;
	molecules: Array<{
		id: string;
		name: string;
		formula: string;
		price: number | null;
		severe: boolean;
	}>;
	reactions: Array<{ id: string; name: string; route: Route }>;
	edges: Array<{ src: string; dst: string; rel: string }>;
	runs: Array<{ id: string; label: string; cut: string[] }>;
}

export interface State {
	year: number;
	at: number | null;
	graph: Graph;
	plan: Plan | null;
	chains: {
		fewestSteps: { path: string[]; steps: number } | null;
		bestYield: { path: string[]; yield: number } | null;
	};
	hazards: Array<{ reaction: string; name: string; molecule: string; hazard: string }>;
	lastEvent: { year: number; label: string } | null;
	changed: Array<{ id: string; type: string; name: string; yield?: number }>;
}

export interface TimelineRow {
	year: number;
	steps: number | null;
	yield: number | null;
	atomEconomy: number | null;
	cost: number | null;
	route: string | null;
}

export interface Version {
	from: number;
	to: number;
	data: { name: string; yield: number; conditions: string; ref: string };
}

export interface Query {
	run: string;
	objective: Objective;
	avoid: boolean;
}

const qs = (q: Query) => `run=${q.run}&objective=${q.objective}&avoid=${q.avoid ? 1 : 0}`;

async function get<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
	return res.json() as Promise<T>;
}

export const api = {
	meta: () => get<Meta>('/api/meta'),
	state: (q: Query, year: number) => get<State>(`/api/state?${qs(q)}&year=${year}`),
	timeline: (q: Query) => get<TimelineRow[]>(`/api/timeline?${qs(q)}`),
	versions: (run: string, id: string) => get<Version[]>(`/api/versions/${id}?run=${run}`),
	whatIf: (cut: string[]) =>
		get<{ id: string }>('/api/whatif', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cut }),
		}),
};
