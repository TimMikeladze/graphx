import type { Layer, PickingInfo } from '@deck.gl/core';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { ArcLayer, PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
	type AskResult,
	type Changes,
	type Compare,
	clock,
	dateOf,
	type Edits,
	g,
	get,
	type Meta,
	type Network,
	type Scenario,
	type Transit,
	type Vehicle,
	type Weights,
	type ZoneDetail,
} from './api.ts';
import { blueColor, congestionColor, deltaColor, hexToRgb, MODE_COLORS } from './layers.ts';
import { type MapHandle, MapView } from './MapView.tsx';
import { GraphProvider } from 'graphx/react';
import {
	ChangesPanel,
	graphPost,
	CommutesPanel,
	CriticalPanel,
	IntersectionPanel,
	RoutePanel,
	SafetyPanel,
	ScenarioPanel,
	TrafficPanel,
	TransitPanel,
} from './panels.tsx';
import {
	type App as AppState,
	AppContext,
	type IntersectionInfo,
	type Selection,
	type Tab,
} from './state.ts';

const TABS: Array<{ id: Tab; label: string; q: string }> = [
	{ id: 'traffic', label: 'Traffic', q: 'How congested is every street right now?' },
	{ id: 'route', label: 'Route', q: 'Fastest drive, and how it changes by hour' },
	{ id: 'commutes', label: 'Commutes', q: 'Who lives where, works where, drives how long' },
	{ id: 'scenarios', label: 'Scenarios', q: 'What if we change this? Who wins, who pays?' },
	{ id: 'critical', label: 'Critical', q: 'Which intersections the city depends on' },
	{ id: 'safety', label: 'Safety', q: 'Where people get hurt' },
	{ id: 'transit', label: 'Buses', q: 'Which buses lose time, live' },
	{ id: 'changes', label: 'Changes', q: 'What changed between two dates' },
];

function useTheme(): 'dark' | 'light' {
	const mq =
		typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: light)') : null;
	const [light, setLight] = useState(mq?.matches ?? false);
	useEffect(() => {
		if (!mq) return;
		const on = (e: MediaQueryListEvent) => setLight(e.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	}, [mq]);
	return light ? 'light' : 'dark';
}

export function App({ meta }: { meta: Meta }) {
	const theme = useTheme();
	const qc = useQueryClient();
	const mapRef = useRef<MapHandle>(null);
	const [tab, setTab] = useState<Tab>('traffic');
	const [t, setT] = useState(meta.amPeak);
	const [playing, setPlaying] = useState(false);
	const [scenario, setScenario] = useState<Scenario | null>(null);
	const [selected, select] = useState<Selection>(null);
	const [draft, setDraft] = useState<Edits>({});
	const [route, setRoute] = useState<{ from: string | null; to: string | null }>({
		from: null,
		to: null,
	});
	const [criticalMetric, setCriticalMetric] = useState<'betweenness' | 'volume' | 'pagerank'>(
		'betweenness',
	);
	const [changeRange, setChangeRange] = useState<'day' | 'week' | 'month'>('week');
	const [ask, setAsk] = useState('');
	const [askQ, setAskQ] = useState('');
	const project = scenario?.project ?? meta.project;

	// --- data -------------------------------------------------------------------------------------
	const network = useQuery({
		queryKey: ['network'],
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: () => get<Network>('/city/network'),
	});
	// Every intersection, straight from graphx's generated /nodes route via its React hook.
	const nodes = g.useListNodes({ type: 'intersection', limit: 20_000 });
	const intersections = useMemo(() => {
		const m = new Map<string, IntersectionInfo>();
		for (const page of nodes.data?.pages ?? [])
			for (const n of page.nodes) m.set(n.id, { id: n.id, ...n.data });
		return m;
	}, [nodes.data]);
	const weights = useQuery({
		queryKey: ['weights', project, t],
		placeholderData: (p) => p,
		queryFn: () => get<Weights>('/city/weights', { t, project }),
	});
	const scenarios = useQuery({
		queryKey: ['scenarios'],
		queryFn: () => get<Scenario[]>('/city/scenarios'),
		refetchInterval: (q) =>
			(q.state.data ?? []).some((s) => s.status === 'running') ? 2000 : false,
	});
	const compare = useQuery({
		queryKey: ['compare', scenario?.project, t],
		enabled: !!scenario && scenario.status === 'done',
		placeholderData: (p) => p,
		queryFn: () => get<Compare>('/city/compare', { project: scenario!.project, t }),
	});
	const zoneKey = selected?.kind === 'zone' ? selected.key : null;
	const zone = useQuery({
		queryKey: ['zone', zoneKey, project],
		enabled: !!zoneKey,
		queryFn: () => get<ZoneDetail>(`/city/zone/${zoneKey}`, { project }),
	});
	const zones = g.useListNodes({ type: 'zone', limit: 5000 });
	const zoneResidents = useMemo(() => {
		const m = new Map<string, number>();
		for (const page of zones.data?.pages ?? [])
			for (const z of page.nodes) m.set(z.data.key, z.data.residents);
		return m;
	}, [zones.data]);
	// The same graphx topNodes queries the panels run — shared through the React Query cache.
	const topCritical = g.useTopNodes({
		by: `score:${meta.scores[criticalMetric]}`,
		type: 'intersection',
		limit: 25,
	});
	const topRisk = g.useTopNodes({
		by: `score:${meta.scores.risk}`,
		type: 'intersection',
		limit: 15,
	});
	const crashes = useQuery({
		queryKey: ['crashes'],
		enabled: tab === 'safety',
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: () => get<Array<[number, number, number, number]>>('/city/crashes'),
	});
	const transit = useQuery({
		queryKey: ['transit'],
		enabled: tab === 'transit',
		refetchInterval: 60_000,
		queryFn: () => get<Transit>('/city/transit'),
	});
	const changesT1 = t - { day: 1, week: 7, month: 30 }[changeRange] * 86_400_000;
	const changes = useQuery({
		queryKey: ['changes', changesT1, t, project],
		enabled: tab === 'changes',
		queryFn: () => get<Changes>('/city/changes', { t1: changesT1, t2: t, project }),
	});
	const asked = useQuery({
		queryKey: ['ask', askQ],
		enabled: askQ.length > 0,
		queryFn: () => get<AskResult>('/city/ask', { q: askQ }),
	});
	// The route the map draws, on whichever graph is active (the panel's hook shares this body).
	const path = useQuery({
		queryKey: ['route-path', project, route.from, route.to, t],
		enabled: !!route.from && !!route.to,
		queryFn: () =>
			graphPost<{ path: string[]; cost: number } | null>(
				meta,
				project,
				'/algorithms/shortest-path',
				{
					src: route.from,
					dst: route.to,
					rels: ['road'],
					types: ['intersection'],
					asOf: t,
				},
			),
	});

	// Live buses over SSE while the transit tab is open.
	const [vehicles, setVehicles] = useState<Vehicle[]>([]);
	const [live, setLive] = useState({ count: 0, hops: 0, error: null as string | null });
	useEffect(() => {
		if (tab !== 'transit') return;
		const es = new EventSource('/city/live');
		es.onmessage = (e) => {
			const d = JSON.parse(e.data) as { vehicles: Vehicle[]; hopsWritten: number };
			setVehicles(d.vehicles);
			setLive({ count: d.vehicles.length, hops: d.hopsWritten, error: null });
		};
		es.onerror = () => setLive((l) => ({ ...l, error: 'live stream interrupted — retrying' }));
		return () => es.close();
	}, [tab]);

	// Play: step through the windows.
	useEffect(() => {
		if (!playing) return;
		const id = setInterval(() => {
			setT((cur) => {
				const i = meta.windows.findIndex((w) => w.t === cur);
				return meta.windows[(i + 1) % meta.windows.length]!.t;
			});
		}, 900);
		return () => clearInterval(id);
	}, [playing, meta.windows]);

	// Prefetch the neighbouring windows so scrubbing feels instant.
	useEffect(() => {
		const i = meta.windows.findIndex((w) => w.t === t);
		for (const j of [i + 1, i + 2]) {
			const w = meta.windows[j];
			if (w)
				void qc.prefetchQuery({
					queryKey: ['weights', project, w.t],
					queryFn: () => get<Weights>('/city/weights', { t: w.t, project }),
				});
		}
	}, [t, project, qc, meta.windows]);

	// --- layers -----------------------------------------------------------------------------------
	const segments = network.data?.segments ?? [];
	const segIndexByPair = useMemo(() => {
		const m = new Map<string, number>();
		segments.forEach((s, i) => {
			const k = `${s.from}>${s.to}`;
			if (!m.has(k)) m.set(k, i);
		});
		return m;
	}, [segments]);

	const layers = useMemo(() => {
		const out: Layer[] = [];
		const w = weights.data;
		const showDelta = !!scenario && !!compare.data && (tab === 'scenarios' || tab === 'traffic');
		const closed = new Set(compare.data?.closed ?? []);
		const segData = segments.map((s, i) => ({ s, i }));

		if (tab === 'commutes') {
			const max = Math.max(1, ...zoneResidents.values());
			out.push(
				new PolygonLayer({
					id: 'zones',
					data: network.data?.zones ?? [],
					getPolygon: (z: Network['zones'][number]) => z.outline[0]!,
					getFillColor: (z: Network['zones'][number]) =>
						z.key === zoneKey
							? [255, 255, 255, 120]
							: blueColor(Math.sqrt((zoneResidents.get(z.key) ?? 0) / max), theme),
					getLineColor: theme === 'dark' ? [20, 20, 20, 160] : [255, 255, 255, 200],
					lineWidthMinPixels: 1,
					pickable: true,
					updateTriggers: { getFillColor: [zoneKey, theme, zoneResidents.size] },
				}),
			);
			const z = zone.data;
			if (z) {
				out.push(
					new ArcLayer({
						id: 'flows',
						data: z.outbound.filter((c) => c.other),
						getSourcePosition: () => [z.lng, z.lat],
						getTargetPosition: (c: ZoneDetail['outbound'][number]) => [c.other!.lng, c.other!.lat],
						getWidth: (c: ZoneDetail['outbound'][number]) => Math.max(1, Math.sqrt(c.drivers)),
						getSourceColor: [57, 135, 229, 220],
						getTargetColor: [235, 104, 52, 220],
						pickable: true,
					}),
				);
			}
			return out;
		}

		out.push(
			new PathLayer({
				id: 'roads',
				data: segData,
				getPath: (d: { s: Network['segments'][number] }) => d.s.coords,
				getColor: (d: { s: Network['segments'][number]; i: number }) => {
					if (showDelta) {
						if (closed.has(d.i)) return [227, 73, 72, 255];
						return deltaColor(compare.data!.delta[d.i] ?? 0, 30, theme);
					}
					const sec = w?.seconds[d.i];
					if (sec === null || sec === undefined) return [120, 120, 120, 60];
					const dim = tab === 'safety' || tab === 'transit' || tab === 'changes';
					const c = congestionColor(sec / d.s.freeFlowSec, theme) as unknown as number[];
					return dim ? [c[0]!, c[1]!, c[2]!, 70] : (c as [number, number, number, number]);
				},
				getWidth: (d: { s: Network['segments'][number]; i: number }) => {
					const major = /motorway|trunk|primary/.test(d.s.highway)
						? 2.2
						: /secondary|tertiary/.test(d.s.highway)
							? 1.5
							: 0.9;
					if (showDelta)
						return closed.has(d.i)
							? 4
							: major + Math.min(Math.abs(compare.data!.delta[d.i] ?? 0) / 15, 3);
					const v = w?.volume[d.i] ?? 0;
					return major + Math.min(v / 900, 3);
				},
				widthUnits: 'pixels',
				widthMinPixels: 0.6,
				capRounded: true,
				pickable: true,
				autoHighlight: true,
				highlightColor: [255, 255, 255, 160],
				updateTriggers: {
					getColor: [w, showDelta, compare.data, theme, tab],
					getWidth: [w, showDelta, compare.data],
				},
			}),
		);

		// Route
		if (path.data && route.from && route.to) {
			const pathSegs: [number, number][][] = [];
			for (let k = 1; k < path.data.path.length; k++) {
				const i = segIndexByPair.get(`${path.data.path[k - 1]}>${path.data.path[k]}`);
				if (i !== undefined) pathSegs.push(segments[i]!.coords);
			}
			out.push(
				new PathLayer({
					id: 'route',
					data: pathSegs,
					getPath: (p: [number, number][]) => p,
					getColor: theme === 'dark' ? [255, 255, 255, 230] : [11, 11, 11, 220],
					getWidth: 5,
					widthUnits: 'pixels',
					capRounded: true,
					jointRounded: true,
				}),
			);
		}
		const ends = [route.from, route.to].flatMap((id, k) => {
			const i = id ? intersections.get(id) : null;
			return i ? [{ i, k }] : [];
		});

		const sigs = [...intersections.values()].filter((i) => i.signal);
		if (tab === 'traffic' || tab === 'scenarios' || tab === 'route') {
			out.push(
				new ScatterplotLayer({
					id: 'signals',
					data: sigs,
					getPosition: (i: IntersectionInfo) => [i.lng, i.lat],
					getRadius: 3.2,
					radiusUnits: 'pixels',
					getFillColor: (i: IntersectionInfo) =>
						draft.signals?.[i.key]
							? [57, 135, 229, 255]
							: theme === 'dark'
								? [235, 235, 230, 210]
								: [40, 40, 40, 200],
					getLineColor: theme === 'dark' ? [26, 26, 25, 255] : [252, 252, 251, 255],
					stroked: true,
					lineWidthMinPixels: 1,
					pickable: true,
					updateTriggers: { getFillColor: [draft, theme] },
				}),
			);
		}
		if (tab === 'route') {
			out.push(
				new ScatterplotLayer({
					id: 'all-intersections',
					data: [...intersections.values()],
					getPosition: (i: IntersectionInfo) => [i.lng, i.lat],
					getRadius: 6,
					radiusUnits: 'pixels',
					getFillColor: [0, 0, 0, 0],
					pickable: true,
				}),
			);
		}
		if (ends.length) {
			out.push(
				new ScatterplotLayer({
					id: 'route-ends',
					data: ends,
					getPosition: (e: { i: IntersectionInfo }) => [e.i.lng, e.i.lat],
					getRadius: 8,
					radiusUnits: 'pixels',
					getFillColor: (e: { k: number }) =>
						e.k === 0 ? [27, 175, 122, 255] : [227, 73, 72, 255],
					getLineColor: [255, 255, 255, 255],
					stroked: true,
					lineWidthMinPixels: 2,
				}),
			);
		}
		const ranked =
			tab === 'critical' ? topCritical.data : tab === 'safety' ? topRisk.data : undefined;
		if (ranked) {
			const rows = ranked.flatMap((r, k) => {
				const i = intersections.get(r.id);
				return i ? [{ ...i, rank: k }] : [];
			});
			out.push(
				new ScatterplotLayer({
					id: 'ranked',
					data: rows,
					getPosition: (i: IntersectionInfo) => [i.lng, i.lat],
					getRadius: (i: { rank: number }) => 14 - Math.min(i.rank, 20) * 0.4,
					radiusUnits: 'pixels',
					getFillColor: (i: { rank: number }) => blueColor(1 - i.rank / rows.length, theme),
					getLineColor: theme === 'dark' ? [255, 255, 255, 220] : [11, 11, 11, 200],
					stroked: true,
					lineWidthMinPixels: 1.5,
					pickable: true,
				}),
			);
		}
		if (tab === 'safety' && crashes.data) {
			out.push(
				new HeatmapLayer({
					id: 'crash-heat',
					data: crashes.data,
					getPosition: (c: [number, number, number, number]) => [c[1], c[0]],
					getWeight: (c: [number, number, number, number]) => (c[2] === 2 ? 3 : c[2] === 1 ? 2 : 1),
					radiusPixels: 16,
					intensity: 0.45,
					threshold: 0.08,
					colorRange: [
						[255, 237, 160],
						[254, 217, 118],
						[253, 141, 60],
						[240, 59, 32],
						[189, 0, 38],
						[128, 0, 38],
					],
				}),
			);
		}
		if (tab === 'transit' && transit.data) {
			const stopPos = new Map(
				transit.data.stops.map((s) => [s.id, [s.lng, s.lat] as [number, number]]),
			);
			const routeColor = new Map(transit.data.routes.map((r) => [r.gtfsId, hexToRgb(r.color)]));
			out.push(
				new PathLayer({
					id: 'bus-links',
					data: transit.data.links.filter((l) => stopPos.has(l.src) && stopPos.has(l.dst)),
					getPath: (l: Transit['links'][number]) => [stopPos.get(l.src)!, stopPos.get(l.dst)!],
					getColor: (l: Transit['links'][number]) =>
						l.observedSec
							? deltaColor(l.observedSec - l.scheduledSec, 120, theme)
							: [...(routeColor.get(l.route) ?? [124, 135, 142]), 110],
					getWidth: (l: Transit['links'][number]) => (l.observedSec ? 4 : 2),
					widthUnits: 'pixels',
					pickable: true,
				}),
				new ScatterplotLayer({
					id: 'buses',
					data: vehicles,
					getPosition: (v: Vehicle) => [v.lng, v.lat],
					getRadius: 5,
					radiusUnits: 'pixels',
					getFillColor: (v: Vehicle) => [...(routeColor.get(v.route) ?? [255, 199, 44]), 255],
					getLineColor: theme === 'dark' ? [255, 255, 255, 255] : [11, 11, 11, 255],
					stroked: true,
					lineWidthMinPixels: 1.5,
					pickable: true,
				}),
			);
		}
		if (tab === 'changes' && changes.data) {
			out.push(
				new ScatterplotLayer({
					id: 'new-reports',
					data: changes.data.reports,
					getPosition: (r: Changes['reports'][number]) => [r.lng, r.lat],
					getRadius: 5,
					radiusUnits: 'pixels',
					getFillColor: [57, 135, 229, 220],
					pickable: true,
				}),
				new ScatterplotLayer({
					id: 'new-crashes',
					data: changes.data.crashes,
					getPosition: (c: Changes['crashes'][number]) => [c.lng, c.lat],
					getRadius: 6,
					radiusUnits: 'pixels',
					getFillColor: (c: Changes['crashes'][number]) =>
						MODE_COLORS[theme][(c.mode as 'mv') ?? 'mv'],
					pickable: true,
				}),
			);
		}
		if (askQ && asked.data) {
			out.push(
				new ScatterplotLayer({
					id: 'answers',
					data: asked.data.rows.filter((r) => r.lat !== null),
					getPosition: (r: AskResult['rows'][number]) => [r.lng!, r.lat!],
					getRadius: 9,
					radiusUnits: 'pixels',
					getFillColor: [0, 0, 0, 0],
					getLineColor: [57, 135, 229, 255],
					stroked: true,
					lineWidthMinPixels: 3,
					pickable: true,
				}),
			);
		}
		if (selected?.kind === 'intersection') {
			const i = intersections.get(selected.id);
			if (i)
				out.push(
					new ScatterplotLayer({
						id: 'selected',
						data: [i],
						getPosition: (x: IntersectionInfo) => [x.lng, x.lat],
						getRadius: 11,
						radiusUnits: 'pixels',
						getFillColor: [0, 0, 0, 0],
						getLineColor: theme === 'dark' ? [255, 255, 255, 255] : [11, 11, 11, 255],
						stroked: true,
						lineWidthMinPixels: 2.5,
					}),
				);
		}
		return out;
	}, [
		segments,
		weights.data,
		scenario,
		compare.data,
		tab,
		theme,
		network.data,
		zone.data,
		zoneKey,
		zoneResidents,
		path.data,
		route,
		intersections,
		segIndexByPair,
		draft,
		crashes.data,
		transit.data,
		vehicles,
		changes.data,
		asked.data,
		askQ,
		selected,
		topCritical.data,
		topRisk.data,
	]);

	// --- interaction ------------------------------------------------------------------------------
	const onClick = (info: PickingInfo) => {
		const id = info.layer?.id;
		const o = info.object as Record<string, unknown> | undefined;
		if (!o) return;
		if (id === 'signals' || id === 'all-intersections' || id === 'selected' || id === 'ranked') {
			const i = o as unknown as IntersectionInfo;
			if (tab === 'route') {
				if (!route.from || (route.from && route.to)) setRoute({ from: i.id, to: null });
				else setRoute({ ...route, to: i.id });
				return;
			}
			select({ kind: 'intersection', id: i.id });
			return;
		}
		if (id === 'roads') {
			const d = o as unknown as { s: Network['segments'][number]; i: number };
			if (tab === 'scenarios') {
				const closed = new Set(draft.closed ?? []);
				if (closed.has(d.s.key)) closed.delete(d.s.key);
				else closed.add(d.s.key);
				setDraft({ ...draft, closed: [...closed] });
				return;
			}
			if (tab === 'route') {
				const end = d.s.to;
				if (!route.from || route.to) setRoute({ from: d.s.from, to: null });
				else setRoute({ ...route, to: end });
				return;
			}
			select({ kind: 'intersection', id: d.s.to });
			return;
		}
		if (id === 'zones') select({ kind: 'zone', key: (o as { key: string }).key });
		if (id === 'answers' || id === 'new-reports' || id === 'new-crashes') {
			const r = o as { id: string; type?: string };
			if (r.type === 'intersection') select({ kind: 'intersection', id: r.id });
		}
	};

	const getTooltip = (info: PickingInfo): string | null => {
		const o = info.object as Record<string, unknown> | undefined;
		if (!o) return null;
		switch (info.layer?.id) {
			case 'roads': {
				const d = o as unknown as { s: Network['segments'][number]; i: number };
				const sec = weights.data?.seconds[d.i];
				const vol = weights.data?.volume[d.i];
				const delta = compare.data?.delta[d.i];
				const lines = [
					d.s.street,
					`${clock(t)}: ${sec ? `${sec.toFixed(0)} s (free flow ${d.s.freeFlowSec.toFixed(0)} s)` : 'closed'}`,
					vol ? `${vol} vehicles/h` : '',
				];
				if (scenario && delta !== undefined && delta !== null)
					lines.push(`scenario: ${delta > 0 ? '+' : ''}${delta.toFixed(1)} s`);
				if (tab === 'scenarios') lines.push('click to close / reopen in the draft');
				return lines.filter(Boolean).join('\n');
			}
			case 'ranked':
				return `#${(o as { rank: number }).rank + 1} · ${(o as unknown as IntersectionInfo).name}`;
			case 'signals':
			case 'all-intersections':
				return (o as unknown as IntersectionInfo).name;
			case 'zones':
				return `${(o as { name: string }).name}\n${(zoneResidents.get((o as { key: string }).key) ?? 0).toLocaleString()} commuters live here`;
			case 'flows': {
				const f = o as unknown as ZoneDetail['outbound'][number];
				return `${f.other?.name}\n${f.drivers.toFixed(0)} drivers · ${f.amMinutes} min`;
			}
			case 'buses':
				return `Route ${(o as unknown as Vehicle).route} · ${(o as unknown as Vehicle).status.toLowerCase().replaceAll('_', ' ')}`;
			case 'bus-links': {
				const l = o as unknown as Transit['links'][number];
				return `Route ${l.route}: scheduled ${l.scheduledSec}s${l.observedSec ? `, observed ${l.observedSec}s` : ''}`;
			}
			case 'new-reports':
				return `311 · ${(o as { type: string }).type}\n${(o as { street: string }).street}`;
			case 'new-crashes':
				return `Crash · ${(o as { mode: string }).mode} · ${(o as { street: string }).street}`;
			case 'answers':
				return (o as { label: string }).label;
			default:
				return null;
		}
	};

	if (!network.data || nodes.isLoading) {
		return (
			<div className="boot">
				Loading Boston — {network.data ? 'intersections' : 'road network'}…
			</div>
		);
	}

	const ctx: AppState = {
		meta,
		theme,
		tab,
		// A tab is a different question: leave any open intersection behind.
		setTab: (x) => {
			setTab(x);
			if (selected?.kind === 'intersection') select(null);
		},
		t,
		setT,
		project,
		scenario,
		setScenario,
		scenarios: scenarios.data ?? [],
		selected,
		select,
		flyTo: (lng, lat, zoom) => mapRef.current?.flyTo(lng, lat, zoom),
		network: network.data,
		intersections,
		draft,
		setDraft,
		route,
		setRoute,
	};

	const idx = meta.windows.findIndex((w) => w.t === t);
	const current = TABS.find((x) => x.id === tab)!;

	return (
		<AppContext.Provider value={ctx}>
			<div className={`app ${theme}`}>
				<header className="top">
					<div className="brand">
						<b>Boston</b> <span className="muted">city graph · graphx</span>
					</div>
					<form
						className="ask"
						onSubmit={(e) => {
							e.preventDefault();
							setAskQ(ask.trim());
						}}
					>
						<input
							value={ask}
							onChange={(e) => setAsk(e.target.value)}
							placeholder="Ask: “most dangerous intersections”, “Dudley Square”, “busiest lights”…"
							aria-label="Ask the graph"
						/>
					</form>
					{scenario && (
						<div className="pill">
							Scenario: {scenario.title}{' '}
							<button type="button" className="link" onClick={() => setScenario(null)}>
								×
							</button>
						</div>
					)}
				</header>
				<nav className="tabs" aria-label="Questions">
					{TABS.map((x) => (
						<button
							key={x.id}
							type="button"
							aria-pressed={tab === x.id}
							title={x.q}
							onClick={() => ctx.setTab(x.id)}
						>
							{x.label}
						</button>
					))}
				</nav>
				<main className="body">
					<aside className="panel">
						<GraphProvider
							tenant={meta.tenant}
							project={project}
							headers={() => ({ 'x-user': meta.user, 'x-tenant': meta.tenant })}
						>
							<p className="question">{current.q}</p>
							{askQ && asked.data && (
								<section className="section answers">
									<h3>
										“{askQ}”{' '}
										<button
											type="button"
											className="link"
											onClick={() => {
												setAskQ('');
												setAsk('');
											}}
										>
											clear
										</button>
									</h3>
									{asked.data.plan && (
										<p className="note">
											Planned as <b>{asked.data.plan.op}</b>
											{asked.data.plan.type ? ` ${asked.data.plan.type}s` : ''}
											{asked.data.plan.metric ? ` by ${asked.data.plan.metric}` : ''}
											{asked.data.plan.confidence !== null
												? ` · confidence ${asked.data.plan.confidence.toFixed(2)}`
												: ' · hybrid search'}
										</p>
									)}
									<ol className="ranked">
										{asked.data.rows.map((r) => (
											<li key={r.id}>
												<button
													type="button"
													className="link"
													onClick={() => {
														if (r.lat !== null && r.lng !== null) ctx.flyTo(r.lng, r.lat);
														if (r.type === 'intersection')
															select({ kind: 'intersection', id: r.id });
														if (r.type === 'zone') {
															setTab('commutes');
															select({ kind: 'zone', key: String(r.data.key) });
														}
													}}
												>
													{r.label}
												</button>
												<span className="muted">{r.type}</span>
											</li>
										))}
									</ol>
								</section>
							)}
							{askQ && asked.isFetching && <p className="loading">Asking the graph…</p>}
							{selected?.kind === 'intersection' && tab !== 'route' ? (
								<IntersectionPanel id={selected.id} />
							) : tab === 'traffic' ? (
								<TrafficPanel />
							) : tab === 'route' ? (
								<RoutePanel />
							) : tab === 'commutes' ? (
								<CommutesPanel />
							) : tab === 'scenarios' ? (
								<ScenarioPanel />
							) : tab === 'critical' ? (
								<CriticalPanel metric={criticalMetric} setMetric={setCriticalMetric} />
							) : tab === 'safety' ? (
								<SafetyPanel crashes={crashes.data} />
							) : tab === 'transit' ? (
								<TransitPanel live={live} observed={observedRatios(transit.data)} />
							) : (
								<ChangesPanel data={changes.data} range={changeRange} setRange={setChangeRange} />
							)}
						</GraphProvider>
					</aside>
					<div className="mapwrap">
						<MapView
							ref={mapRef}
							layers={layers}
							theme={theme}
							onClick={onClick}
							getTooltip={getTooltip}
						/>
						<div className="timebar">
							<button
								type="button"
								className="play"
								onClick={() => setPlaying(!playing)}
								aria-label={playing ? 'Pause' : 'Play the day'}
							>
								{playing ? '❚❚' : '▶'}
							</button>
							<div className="time">
								<b>{clock(t)}</b>
								<span className="muted">{dateOf(t)} · modelled</span>
							</div>
							<input
								type="range"
								min={0}
								max={meta.windows.length - 1}
								value={idx}
								onChange={(e) => setT(meta.windows[Number(e.target.value)]!.t)}
								aria-label="Time of day"
							/>
							{weights.isFetching && <span className="muted spin">·</span>}
						</div>
					</div>
				</main>
			</div>
		</AppContext.Provider>
	);
}

function observedRatios(t: Transit | undefined) {
	if (!t) return [];
	const m = new Map<string, { obs: number; sched: number; n: number }>();
	for (const l of t.links) {
		if (!l.observedSec) continue;
		const r = m.get(l.route) ?? { obs: 0, sched: 0, n: 0 };
		r.obs += l.observedSec;
		r.sched += l.scheduledSec;
		r.n++;
		m.set(l.route, r);
	}
	return [...m]
		.map(([route, r]) => ({ route, ratio: r.obs / r.sched, n: r.n }))
		.filter((r) => r.n >= 2)
		.sort((a, b) => b.ratio - a.ratio);
}
