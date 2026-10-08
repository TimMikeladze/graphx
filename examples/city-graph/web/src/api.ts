import { createGraphHooks } from 'graphx/react';
import type { Schema } from '../../schema.ts';

/**
 * graphx's React hooks, typed from the schema TYPE alone — no graphx runtime in the bundle. They
 * hit the generated routes (`/t/{tenant}/p/{project}/…`) of whichever project the provider names:
 * the baseline city, or a scenario branch.
 */
export const g = createGraphHooks<Schema>();

export interface Meta {
	tenant: string;
	project: string;
	user: string;
	day: number;
	windows: Array<{ start: number; minutes: number; t: number }>;
	amPeak: number;
	pmPeak: number;
	baseline: { vehicleHours: number; roadVersions: number; commutes: number };
	scores: { betweenness: string; pagerank: string; volume: string; risk: string };
	counts: Record<string, number>;
}

export interface Segment {
	id: string;
	key: string;
	from: string;
	to: string;
	street: string;
	highway: string;
	freeFlowSec: number;
	coords: [number, number][];
}
export interface ZoneShape {
	id: string;
	key: string;
	name: string;
	neighborhood: string;
	outline: [number, number][][][];
}
export interface Network {
	segments: Segment[];
	zones: ZoneShape[];
}
export interface Weights {
	seconds: (number | null)[];
	volume: (number | null)[];
}
export interface DayRow {
	t: number;
	start: number;
	minutes: number;
	vehicles: number;
	slowdown: number;
}

export interface Signal {
	cityId: number;
	name: string;
	cycleSec: number;
	green: Record<string, number>;
	synthetic: boolean;
}
export interface IntersectionDetail {
	id: string;
	key: string;
	name: string;
	lat: number;
	lng: number;
	signal: Signal | null;
	versions: Array<{ validFrom: number; signal: Signal | null }>;
	byWindow: Array<{ t: number; start: number; volume: number; delaySec: number }>;
	approaches: Array<{
		id: string;
		street: string;
		volume: number;
		seconds: number;
		freeFlowSec: number;
	}>;
	passing: {
		drivers: number;
		commutes: number;
		neighborhoods: Array<{ name: string; drivers: number; commutes: number }>;
		zones: Array<{ key: string; drivers: number }>;
	};
	crashes: Array<{
		id: string;
		at: number;
		mode: 'ped' | 'bike' | 'mv';
		street: string;
		lat: number;
		lng: number;
	}>;
	reports: Array<{ id: string; type: string; status: string; openedAt: number; street: string }>;
	ranks: Record<
		'betweenness' | 'volume' | 'risk' | 'pagerank',
		{ rank: number; score: number } | null
	>;
}

export interface Commute {
	home: string;
	work: string;
	workers: number;
	drivers: number;
	amMinutes: number;
	pmMinutes: number;
	other: { key: string; name: string; neighborhood: string; lat: number; lng: number } | null;
}
export interface ZoneDetail {
	key: string;
	name: string;
	neighborhood: string;
	lat: number;
	lng: number;
	kind: 'boston' | 'external';
	outbound: Commute[];
	inbound: Commute[];
}

export interface Edits {
	signals?: Record<string, { cycleSec: number; green: Record<string, number> }>;
	closed?: string[];
	lanes?: Record<string, number>;
	jobs?: Record<string, number>;
}
export interface Scenario {
	id: string;
	title: string;
	namespace: string;
	project: string;
	edits: Edits;
	status: 'running' | 'done' | 'failed';
	progress: number;
	summary: { vehicleHours?: number; error?: string } | null;
}
export interface Compare {
	t: number;
	delta: (number | null)[];
	closed: number[];
	zones: Array<{
		key: string;
		name: string;
		neighborhood: string;
		lat: number;
		lng: number;
		drivers: number;
		baseMinutes: number;
		deltaMinutes: number;
	}>;
	totals: {
		vehicleHoursBase: number;
		vehicleHoursScenario: number;
		commuteHoursDelta: number;
		changedSignals: number;
	};
}

export interface Vehicle {
	id: string;
	route: string;
	lat: number;
	lng: number;
	bearing: number;
	status: string;
}
export interface Transit {
	routes: Array<{ id: string; gtfsId: string; name: string; longName: string; color: string }>;
	stops: Array<{ id: string; gtfsId: string; name: string; lat: number; lng: number }>;
	links: Array<{
		id: string;
		src: string;
		dst: string;
		seconds: number;
		route: string;
		scheduledSec: number;
		observedSec: number | null;
	}>;
}

export interface AskResult {
	plan: {
		op: string;
		type: string | null;
		metric: string | null;
		confidence: number | null;
	} | null;
	rows: Array<{
		id: string;
		type: string;
		label: string;
		lat: number | null;
		lng: number | null;
		data: Record<string, unknown>;
	}>;
}

export interface Changes {
	t1: number;
	t2: number;
	nodes: Record<string, { opened: number; closed: number }>;
	edges: Record<string, { opened: number; closed: number }>;
	reports: Array<{
		id: string;
		type: string;
		street: string;
		lat: number;
		lng: number;
		openedAt: number;
		status: string;
	}>;
	crashes: Array<{
		id: string;
		at: number;
		mode: string;
		street: string;
		lat: number;
		lng: number;
	}>;
}

export async function get<T>(
	path: string,
	params: Record<string, string | number | undefined> = {},
): Promise<T> {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
	const res = await fetch(`${path}${q.size ? `?${q}` : ''}`);
	if (!res.ok) throw new Error(`${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
	return (await res.json()) as T;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
	return (await res.json()) as T;
}

const clockFmt = new Intl.DateTimeFormat('en-US', {
	timeZone: 'America/New_York',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});
const dateFmt = new Intl.DateTimeFormat('en-US', {
	timeZone: 'America/New_York',
	weekday: 'short',
	month: 'short',
	day: 'numeric',
	year: 'numeric',
});
export const clock = (t: number) => clockFmt.format(t);
export const dateOf = (t: number) => dateFmt.format(t);
export const minutes = (m: number) =>
	`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const fmt = new Intl.NumberFormat('en-US');
