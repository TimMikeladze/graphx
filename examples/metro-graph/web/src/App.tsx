import type { Layer, PickingInfo } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
	type Compare,
	clock,
	DAYS,
	type Day,
	fmt,
	type GraphNode,
	get,
	type Hop,
	type Meta,
	type Neighbourhood,
	type Network,
	type PatternRow,
	post,
	type RouteDetail,
	type Scenario,
	type StopDetail,
	type StopRow,
	type Vehicle,
	withProject,
} from './api.ts';
import { HourlyChart } from './charts.tsx';
import { boundsOf, graphLayers } from './graphLayers.ts';
import { type Crumb, GraphPanel } from './GraphPanel.tsx';
import { GraphView } from './GraphView.tsx';
import { blueColor, deltaColor } from './layers.ts';
import { type MapHandle, MapView } from './MapView.tsx';
import { scheduledBuses, tripsPerHour } from './sim.ts';

type Selection = { kind: 'route' | 'stop'; id: string } | null;
interface GraphState {
	trail: Crumb[];
	depth: 1 | 2;
	expand: string[];
	view: 'abstract' | 'spatial';
	hops: boolean;
}
type Theme = 'dark' | 'light';

const DAY_BIT: Record<Day, number> = { weekday: 1, saturday: 2, sunday: 4 };
const T_MIN = 4 * 3600;
const T_MAX = 27 * 3600;

function useTheme(): Theme {
	const q = '(prefers-color-scheme: light)';
	const [light, setLight] = useState(() => window.matchMedia(q).matches);
	useEffect(() => {
		const m = window.matchMedia(q);
		const on = () => setLight(m.matches);
		m.addEventListener('change', on);
		return () => m.removeEventListener('change', on);
	}, []);
	return light ? 'light' : 'dark';
}

export function App({ meta }: { meta: Meta }) {
	const theme = useTheme();
	const qc = useQueryClient();
	const map = useRef<MapHandle>(null);
	const [project, setProject] = useState<string | null>(null);
	const [day, setDay] = useState<Day>('weekday');
	const [t, setT] = useState(8 * 3600);
	const [playing, setPlaying] = useState(false);
	const [show, setShow] = useState({ scheduled: true, live: false, stops: true });
	const [sel, setSel] = useState<Selection>(null);
	const [draft, setDraft] = useState<string[] | null>(null);
	const [filter, setFilter] = useState('');
	const [mode, setMode] = useState<'map' | 'graph'>('map');
	const [graph, setGraph] = useState<GraphState>({
		trail: [],
		depth: 1,
		expand: [],
		view: 'abstract',
		hops: false,
	});

	const scenarios = useQuery({
		queryKey: ['scenarios'],
		queryFn: () => get<Scenario[]>('/metro/scenarios'),
		refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'forking') ? 1500 : false),
	});
	const scenario = scenarios.data?.find((s) => s.project === project) ?? null;
	const network = useQuery({
		queryKey: ['network', project],
		queryFn: () => get<Network>(withProject('/metro/network', project)),
	});
	const compare = useQuery({
		queryKey: ['compare', project],
		queryFn: () => get<Compare>(withProject('/metro/compare', project)),
		enabled: !!project,
	});
	const vehicles = useQuery({
		queryKey: ['vehicles'],
		queryFn: () =>
			get<{ vehicles: Vehicle[]; fetchedAt: number; error: string | null }>('/metro/vehicles'),
		enabled: show.live,
		refetchInterval: 15_000,
	});

	// Play runs the service day at 60× (one minute per second).
	useEffect(() => {
		if (!playing) return;
		let last = performance.now();
		let raf = 0;
		const tick = (now: number) => {
			const dt = (now - last) / 1000;
			last = now;
			setT((x) => (x + dt * 60 >= T_MAX ? T_MIN : x + dt * 60));
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [playing]);

	const focus = graph.trail[graph.trail.length - 1] ?? null;
	const hood = useQuery({
		queryKey: ['graph-node', project, focus?.id, graph.depth, graph.expand.join(',')],
		queryFn: () =>
			get<Neighbourhood>(
				withProject(
					`/metro/graph/node/${focus!.id}?depth=${graph.depth}${graph.expand.length ? `&expand=${encodeURIComponent(graph.expand.join(','))}` : ''}`,
					project,
				),
			),
		enabled: mode === 'graph' && !!focus,
		placeholderData: (prev) => (prev?.focus.id === focus?.id ? prev : undefined),
	});
	const hops = useQuery({
		queryKey: ['graph-hops', project],
		queryFn: () => get<Hop[]>(withProject('/metro/graph/hops', project)),
		enabled: mode === 'graph' && graph.view === 'spatial' && graph.hops,
	});
	// Walking back to a node already on the trail cuts the trail there, so the breadcrumb is a path.
	const walk = (c: Crumb) =>
		setGraph((g) => {
			if (g.trail[g.trail.length - 1]?.id === c.id) return g;
			const seen = g.trail.findIndex((x) => x.id === c.id);
			const trail =
				seen >= 0
					? g.trail.slice(0, seen + 1)
					: [...g.trail, { id: c.id, type: c.type, label: c.label }];
			return { ...g, trail, expand: [] };
		});
	const openInGraph = (c: Crumb) => {
		setMode('graph');
		walk(c);
	};

	const net = network.data;
	const patternById = useMemo(() => new Map((net?.patterns ?? []).map((p) => [p.id, p])), [net]);
	const stopById = useMemo(() => new Map((net?.stops ?? []).map((s) => [s.id, s])), [net]);
	const routeOf = useMemo(() => new Map((net?.routes ?? []).map((r) => [r.gtfsId, r])), [net]);
	const stopOf = useMemo(() => new Map((net?.stops ?? []).map((s) => [s.gtfsId, s])), [net]);
	const delta = useMemo(() => {
		const m = new Map<string, number>();
		for (const r of compare.data?.routes ?? [])
			if (r.day === day) m.set(r.route, r.after - r.before);
		return m;
	}, [compare.data, day]);

	const refresh = () => {
		for (const k of [
			'network',
			'route',
			'stop',
			'compare',
			'scenarios',
			'graph-node',
			'graph-schema',
			'graph-hops',
			'graph-search',
		])
			void qc.invalidateQueries({ queryKey: [k] });
	};

	const graphMapLayers = useMemo<Layer[]>(
		() =>
			net && mode === 'graph' && graph.view === 'spatial'
				? graphLayers({
						hood: hood.data,
						patterns: net.patterns,
						patternById,
						stopById,
						hops: graph.hops ? hops.data : undefined,
						theme,
					})
				: [],
		[net, mode, graph.view, graph.hops, hood.data, hops.data, patternById, stopById, theme],
	);
	// Frame the neighbourhood once per focus when the spatial view shows it.
	const framed = useRef<string | null>(null);
	useEffect(() => {
		if (mode !== 'graph' || graph.view !== 'spatial' || !hood.data) return;
		const key = `${hood.data.focus.id}:${graph.depth}`;
		if (framed.current === key) return;
		const b = boundsOf(hood.data.nodes, patternById);
		if (b) {
			framed.current = key;
			map.current?.fitBounds(b);
		}
	}, [mode, graph.view, graph.depth, hood.data, patternById]);

	const layers = useMemo<Layer[]>(() => {
		if (!net) return [];
		const bit = DAY_BIT[day];
		const selRoute = sel?.kind === 'route' ? sel.id : null;
		const out: Layer[] = [
			new PathLayer<PatternRow>({
				id: 'patterns',
				data: net.patterns,
				getPath: (p) => p.coords,
				getColor: (p) => {
					// In a scenario, changed routes carry the diverging colour; the rest go neutral.
					if (project) return deltaColor(delta.get(p.route) ?? 0, 40, theme);
					return blueColor(Math.min(tripsPerHour(p, t, bit) / 8, 1), theme);
				},
				getWidth: (p) => 1 + Math.min(tripsPerHour(p, t, bit), 12) / 3,
				widthUnits: 'pixels',
				capRounded: true,
				jointRounded: true,
				pickable: true,
				autoHighlight: true,
				highlightColor: [255, 196, 0, 220],
				updateTriggers: { getColor: [t, day, delta, theme, project], getWidth: [t, day] },
			}),
		];
		if (selRoute)
			out.push(
				new PathLayer<PatternRow>({
					id: 'selected',
					data: net.patterns.filter((p) => p.route === selRoute),
					getPath: (p) => p.coords,
					getColor: [255, 196, 0, 235],
					getWidth: 5,
					widthUnits: 'pixels',
					capRounded: true,
					jointRounded: true,
				}),
			);
		if (show.stops)
			out.push(
				new ScatterplotLayer<StopRow>({
					id: 'stops',
					data: net.stops,
					getPosition: (s) => [s.lng, s.lat],
					getRadius: (s) =>
						draft?.includes(s.gtfsId)
							? 6
							: sel?.kind === 'stop' && sel.id === s.gtfsId
								? 7
								: draft
									? 4
									: 2,
					radiusUnits: 'pixels',
					getFillColor: (s) =>
						draft?.includes(s.gtfsId)
							? [228, 87, 46, 255]
							: theme === 'dark'
								? [210, 210, 205, 170]
								: [70, 70, 66, 170],
					pickable: true,
					autoHighlight: true,
					updateTriggers: { getRadius: [draft, sel], getFillColor: [draft, theme] },
				}),
			);
		if (draft && draft.length > 1)
			out.push(
				new PathLayer({
					id: 'draft',
					data: [draft.map((id) => [stopOf.get(id)!.lng, stopOf.get(id)!.lat])],
					getPath: (d: [number, number][]) => d,
					getColor: [228, 87, 46, 230],
					getWidth: 4,
					widthUnits: 'pixels',
				}),
			);
		if (show.scheduled)
			out.push(
				new ScatterplotLayer({
					id: 'scheduled',
					data: scheduledBuses(net.patterns, t, bit),
					getPosition: (b: { position: [number, number] }) => b.position,
					getRadius: 3.5,
					radiusUnits: 'pixels',
					getFillColor: theme === 'dark' ? [255, 255, 255, 230] : [11, 11, 11, 220],
					stroked: true,
					getLineColor: [57, 135, 229, 255],
					lineWidthUnits: 'pixels',
					getLineWidth: 1.5,
				}),
			);
		if (show.live && vehicles.data)
			out.push(
				new ScatterplotLayer<Vehicle>({
					id: 'live',
					data: vehicles.data.vehicles,
					getPosition: (v) => [v.lng, v.lat],
					getRadius: 5,
					radiusUnits: 'pixels',
					getFillColor: [217, 89, 38, 240],
					stroked: true,
					getLineColor: [255, 255, 255, 255],
					lineWidthUnits: 'pixels',
					getLineWidth: 1,
					pickable: true,
				}),
			);
		return out;
	}, [net, t, day, sel, show, vehicles.data, theme, draft, stopOf, delta, project]);

	const crumbOfPattern = (p: PatternRow): Crumb => ({
		id: p.id,
		type: 'pattern',
		label: `${routeOf.get(p.route)?.short ?? p.route} to ${p.headsign}, ${p.offsets.length} stops`,
	});
	const onGraphClick = (info: PickingInfo) => {
		if (!info.object) return;
		const id = info.layer?.id;
		if (id === 'g-nodes') {
			const n = info.object as GraphNode;
			if (n.group) {
				if (n.group.expandable) setGraph((g) => ({ ...g, expand: [...g.expand, n.group!.key] }));
			} else walk(n);
		} else if (id === 'g-patterns') walk(info.object as GraphNode);
		else if (id === 'g-base') walk(crumbOfPattern(info.object as PatternRow));
		else if (id === 'g-hops' || id === 'g-hop-edges') {
			const src = id === 'g-hops' ? (info.object as Hop)[0] : (info.object as { src: string }).src;
			const s = stopById.get(src);
			if (s) walk({ id: s.id, type: 'stop', label: s.name });
		}
	};
	const getGraphTooltip = (info: PickingInfo) => {
		if (!info.object) return null;
		const id = info.layer?.id;
		if (id === 'g-nodes' || id === 'g-patterns') {
			const n = info.object as GraphNode;
			return n.group
				? `${n.label} over ${n.group.rel}${n.group.expandable ? ', click to expand' : ''}`
				: `${n.type}: ${n.label}`;
		}
		if (id === 'g-base') return `pattern: ${crumbOfPattern(info.object as PatternRow).label}`;
		if (id === 'g-hops') {
			const [a, b, sec, trips] = info.object as Hop;
			return `hop ${stopById.get(a)?.name} to ${stopById.get(b)?.name} · ${Math.round(sec)} s · ${trips} trips`;
		}
		if (id === 'g-hop-edges') {
			const e = info.object as { src: string; dst: string; weight: number };
			return `hop ${stopById.get(e.src)?.name} to ${stopById.get(e.dst)?.name} · ${Math.round(e.weight)} s`;
		}
		return null;
	};

	const onClick = (info: PickingInfo) => {
		if (!info.object) return;
		if (info.layer?.id === 'stops') {
			const s = info.object as StopRow;
			if (draft)
				setDraft(
					draft.includes(s.gtfsId) ? draft.filter((x) => x !== s.gtfsId) : [...draft, s.gtfsId],
				);
			else setSel({ kind: 'stop', id: s.gtfsId });
		} else if (info.layer?.id === 'patterns' && !draft)
			setSel({ kind: 'route', id: (info.object as PatternRow).route });
		else if (info.layer?.id === 'live')
			setSel({ kind: 'route', id: (info.object as Vehicle).route });
	};
	const getTooltip = (info: PickingInfo) => {
		if (!info.object) return null;
		if (info.layer?.id === 'stops') {
			const s = info.object as StopRow;
			return `${s.name} · stop ${s.code}`;
		}
		if (info.layer?.id === 'patterns') {
			const p = info.object as PatternRow;
			const r = routeOf.get(p.route);
			const d = delta.get(p.route);
			return `${r?.short ?? p.route} to ${p.headsign} · ${tripsPerHour(p, t, DAY_BIT[day])} trips in the hour around ${clock(t)}${d ? ` · ${d > 0 ? '+' : ''}${d} trips/day in scenario` : ''}`;
		}
		if (info.layer?.id === 'live') {
			const v = info.object as Vehicle;
			return `Bus ${v.id} · route ${routeOf.get(v.route)?.short ?? v.route} · ${v.status} ${stopOf.get(v.stop)?.name ?? v.stop}`;
		}
		return null;
	};

	const routes = useMemo(() => {
		const q = filter.trim().toLowerCase();
		return (net?.routes ?? [])
			.filter((r) => !q || `${r.short} ${r.long} ${r.desc}`.toLowerCase().includes(q))
			.sort((a, b) => a.short.localeCompare(b.short, undefined, { numeric: true }));
	}, [net, filter]);

	return (
		<div className="app">
			<aside className="side">
				<header>
					<h1>King County Metro</h1>
					<div className="muted">
						{meta.feed.publisher} feed {meta.feed.version} · {fmt.format(meta.counts.routes)} routes
						· {fmt.format(meta.counts.stops)} stops · {fmt.format(meta.counts.trips)} trips
					</div>
					<fieldset className="row bare" aria-label="Mode">
						<button type="button" aria-pressed={mode === 'map'} onClick={() => setMode('map')}>
							Map
						</button>
						<button type="button" aria-pressed={mode === 'graph'} onClick={() => setMode('graph')}>
							Graph
						</button>
					</fieldset>
				</header>

				<ScenarioBar
					scenarios={scenarios.data ?? []}
					project={project}
					onPick={(p) => {
						setProject(p);
						setDraft(null);
					}}
					onCreated={() => void qc.invalidateQueries({ queryKey: ['scenarios'] })}
				/>

				{mode === 'graph' ? (
					<div className="panel">
						<GraphPanel
							project={project}
							trail={graph.trail}
							hood={hood.data}
							error={hood.error}
							onFocus={walk}
							onCrumb={(i) =>
								setGraph((g) => ({ ...g, trail: g.trail.slice(0, i + 1), expand: [] }))
							}
						/>
					</div>
				) : (
					<>
						<section className="time">
							<div className="row">
								{DAYS.map((d) => (
									<button key={d} type="button" aria-pressed={d === day} onClick={() => setDay(d)}>
										{d[0]!.toUpperCase() + d.slice(1)}
									</button>
								))}
								<button
									type="button"
									onClick={() => setPlaying(!playing)}
									aria-label={playing ? 'Pause' : 'Play'}
								>
									{playing ? 'Pause' : 'Play'}
								</button>
							</div>
							<div className="row">
								<input
									type="range"
									min={T_MIN}
									max={T_MAX}
									step={60}
									value={t}
									onChange={(e) => setT(Number(e.target.value))}
									aria-label="Time of day"
								/>
								<span className="clock">{clock(t)}</span>
							</div>
							<div className="row small">
								{(['scheduled', 'live', 'stops'] as const).map((k) => (
									<label key={k}>
										<input
											type="checkbox"
											checked={show[k]}
											onChange={(e) => setShow({ ...show, [k]: e.target.checked })}
										/>{' '}
										{k === 'scheduled'
											? 'Scheduled buses'
											: k === 'live'
												? 'Live buses (now)'
												: 'Stops'}
									</label>
								))}
							</div>
							{show.live && vehicles.data && (
								<div className="muted small">
									{vehicles.data.error
										? `Live feed: ${vehicles.data.error}`
										: `${vehicles.data.vehicles.length} buses reporting, ${new Date(vehicles.data.fetchedAt).toLocaleTimeString()}`}
								</div>
							)}
						</section>

						<div className="panel">
							{network.isError && <div className="error">{String(network.error)}</div>}
							{draft ? (
								<DraftPanel
									draft={draft}
									stopOf={stopOf}
									scenario={scenario!}
									onCancel={() => setDraft(null)}
									onSaved={() => {
										setDraft(null);
										refresh();
									}}
									onUndo={() => setDraft(draft.slice(0, -1))}
								/>
							) : sel?.kind === 'route' ? (
								<RoutePanel
									route={sel.id}
									project={project}
									scenario={scenario}
									day={day}
									onBack={() => setSel(null)}
									onEdited={(removed) => {
										if (removed) setSel(null);
										refresh();
									}}
									onFocus={(lng, lat) => map.current?.flyTo(lng, lat, 13)}
									stopOf={stopOf}
									onGraph={openInGraph}
								/>
							) : sel?.kind === 'stop' ? (
								<StopPanel
									stop={sel.id}
									project={project}
									day={day}
									t={t}
									onBack={() => setSel(null)}
									onRoute={(id) => setSel({ kind: 'route', id })}
									onGraph={openInGraph}
								/>
							) : (
								<>
									{scenario && (
										<ComparePanel
											scenario={scenario}
											compare={compare.data}
											day={day}
											onDraw={() => setDraft([])}
											onStop={(id) => {
												const s = stopOf.get(id);
												if (s) map.current?.flyTo(s.lng, s.lat, 15);
											}}
										/>
									)}
									<input
										className="text"
										placeholder="Filter routes"
										value={filter}
										onChange={(e) => setFilter(e.target.value)}
									/>
									<ul className="routes">
										{routes.map((r) => (
											<li key={r.gtfsId}>
												<button
													type="button"
													className="route-row"
													onClick={() => setSel({ kind: 'route', id: r.gtfsId })}
												>
													<span className="badge" style={{ background: r.color, color: '#000' }}>
														{r.short}
													</span>
													<span className="desc">{r.desc || r.long}</span>
													{delta.has(r.gtfsId) && (
														<span className={delta.get(r.gtfsId)! > 0 ? 'up' : 'down'}>
															{delta.get(r.gtfsId)! > 0 ? '+' : ''}
															{delta.get(r.gtfsId)}
														</span>
													)}
												</button>
											</li>
										))}
									</ul>
								</>
							)}
						</div>
					</>
				)}
			</aside>
			<main className="stage">
				<MapView
					ref={map}
					layers={mode === 'graph' ? graphMapLayers : layers}
					theme={theme}
					onClick={mode === 'graph' ? onGraphClick : onClick}
					getTooltip={mode === 'graph' ? getGraphTooltip : getTooltip}
				/>
				{mode === 'graph' && graph.view === 'abstract' && (
					<GraphView
						hood={hood.data}
						loading={hood.isFetching}
						onFocus={walk}
						onExpand={(key) => setGraph((g) => ({ ...g, expand: [...g.expand, key] }))}
					/>
				)}
				{mode === 'graph' && (
					<div className="graph-tools">
						<fieldset className="row nowrap bare" aria-label="Graph view">
							{(['abstract', 'spatial'] as const).map((v) => (
								<button
									key={v}
									type="button"
									aria-pressed={graph.view === v}
									onClick={() => setGraph({ ...graph, view: v })}
								>
									{v === 'abstract' ? 'Abstract' : 'Spatial'}
								</button>
							))}
						</fieldset>
						<fieldset className="row nowrap bare" aria-label="Depth">
							{([1, 2] as const).map((d) => (
								<button
									key={d}
									type="button"
									aria-pressed={graph.depth === d}
									onClick={() => setGraph({ ...graph, depth: d })}
								>
									{d} hop{d > 1 ? 's' : ''}
								</button>
							))}
						</fieldset>
						{graph.view === 'spatial' && (
							<label className="row nowrap small">
								<input
									type="checkbox"
									checked={graph.hops}
									onChange={(e) => setGraph({ ...graph, hops: e.target.checked })}
								/>
								Network hops{graph.hops && hops.data ? ` (${fmt.format(hops.data.length)})` : ''}
							</label>
						)}
						{hood.isFetching && <span className="muted small">Loading…</span>}
					</div>
				)}
			</main>
			{draft && (
				<div className="hint">
					Click stops in order to draw the new route. Click a stop again to drop it.
				</div>
			)}
		</div>
	);
}

function ScenarioBar({
	scenarios,
	project,
	onPick,
	onCreated,
}: {
	scenarios: Scenario[];
	project: string | null;
	onPick: (p: string | null) => void;
	onCreated: () => void;
}) {
	const [title, setTitle] = useState('');
	const [busy, setBusy] = useState(false);
	const forking = scenarios.filter((s) => s.status === 'forking');
	return (
		<section className="scenarios">
			<div className="row">
				<select
					value={project ?? ''}
					onChange={(e) => onPick(e.target.value || null)}
					aria-label="Network to show"
				>
					<option value="">Baseline (published schedule)</option>
					{scenarios
						.filter((s) => s.status === 'ready')
						.map((s) => (
							<option key={s.id} value={s.project}>
								Scenario: {s.title} ({s.edits.length} edits)
							</option>
						))}
				</select>
			</div>
			<form
				className="row"
				onSubmit={async (e) => {
					e.preventDefault();
					setBusy(true);
					try {
						await post('/metro/scenarios', { title: title || 'Untitled scenario' });
						setTitle('');
						onCreated();
					} finally {
						setBusy(false);
					}
				}}
			>
				<input
					className="text"
					placeholder="New scenario title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<button type="submit" disabled={busy}>
					Fork
				</button>
			</form>
			{forking.length > 0 && (
				<div className="muted small">
					Forking {forking.map((s) => s.title).join(', ')}… (about a second)
				</div>
			)}
		</section>
	);
}

function ComparePanel({
	scenario,
	compare,
	day,
	onDraw,
	onStop,
}: {
	scenario: Scenario;
	compare: Compare | undefined;
	day: Day;
	onDraw: () => void;
	onStop: (gtfsId: string) => void;
}) {
	const d = compare?.days[day];
	const row = (label: string, a: number, b: number, unit = '') => (
		<tr>
			<td>{label}</td>
			<td>{fmt.format(a)}</td>
			<td>{fmt.format(b)}</td>
			<td className={b > a ? 'up' : b < a ? 'down' : ''}>
				{b === a ? '0' : `${b > a ? '+' : ''}${fmt.format(b - a)}${unit}`}
			</td>
		</tr>
	);
	return (
		<section className="compare">
			<h2>{scenario.title}</h2>
			<p className="muted small">
				Click a route on the map or in the list to change its timetable or remove it. Routes
				coloured blue gain trips on the selected day, red lose them.
			</p>
			<button type="button" onClick={onDraw}>
				Draw a new route
			</button>
			{d && (
				<table>
					<thead>
						<tr>
							<th>{day}</th>
							<th>Baseline</th>
							<th>Scenario</th>
							<th>Change</th>
						</tr>
					</thead>
					<tbody>
						{row('Trips', d.before.trips, d.after.trips)}
						{row('Revenue hours', d.before.revenueHours, d.after.revenueHours)}
						{row('Stops served', d.before.stopsServed, d.after.stopsServed)}
					</tbody>
				</table>
			)}
			{compare && compare.stopsLost[day].length > 0 && (
				<details>
					<summary>{compare.stopsLost[day].length} stops lose all service</summary>
					<ul className="plain">
						{compare.stopsLost[day].map((s) => (
							<li key={s.gtfsId}>
								<button type="button" className="link" onClick={() => onStop(s.gtfsId)}>
									{s.name}
								</button>
							</li>
						))}
					</ul>
				</details>
			)}
			{compare && (
				<p className="muted small">
					{compare.versions.nodes} node and {compare.versions.edges} edge versions written in the
					branch since the fork.
				</p>
			)}
			{scenario.edits.length > 0 && (
				<>
					<h3>Edits</h3>
					<ul className="plain small">
						{scenario.edits.map((e, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the edit log is append-only
							<li key={i}>{e.result ?? e.op}</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}

function RoutePanel({
	route,
	project,
	scenario,
	day,
	onBack,
	onEdited,
	onFocus,
	stopOf,
	onGraph,
}: {
	route: string;
	project: string | null;
	scenario: Scenario | null;
	day: Day;
	onBack: () => void;
	onEdited: (removed: boolean) => void;
	onFocus: (lng: number, lat: number) => void;
	stopOf: Map<string, StopRow>;
	onGraph: (c: Crumb) => void;
}) {
	const q = useQuery({
		queryKey: ['route', project, route],
		queryFn: () =>
			get<RouteDetail>(withProject(`/metro/route/${encodeURIComponent(route)}`, project)),
	});
	const [dir, setDir] = useState(0);
	const r = q.data;
	const focused = useRef<string | null>(null);
	useEffect(() => {
		const first = r?.patterns[0]?.stops[Math.floor((r.patterns[0]?.stops.length ?? 0) / 2)];
		const s = first && stopOf.get(first.gtfsId);
		if (s && focused.current !== route) {
			focused.current = route;
			onFocus(s.lng, s.lat);
		}
	}, [r, route, stopOf, onFocus]);
	if (q.isError) return <div className="error">{String(q.error)}</div>;
	if (!r) return <div className="muted">Loading route…</div>;
	const headsign = (d: number) =>
		r.patterns.find((p) => p.direction === d)?.headsign ?? `Direction ${d}`;
	const trips = r.trips.filter((x) => x.direction === dir && x.days.includes(day));
	const main = r.patterns.find((p) => p.direction === dir);
	return (
		<section>
			<button type="button" className="link" onClick={onBack}>
				Back to routes
			</button>
			<h2>
				<span className="badge" style={{ background: r.route.color, color: '#000' }}>
					{r.route.short}
				</span>{' '}
				{r.route.desc || r.route.long}
			</h2>
			<div className="muted small">
				{r.route.agency} · {r.route.mode} · {r.patterns.length} patterns · {r.trips.length} trips
				across all days ·{' '}
				<button
					type="button"
					className="link"
					onClick={() =>
						onGraph({ id: r.route.id, type: 'route', label: `Route ${r.route.short}` })
					}
				>
					Explore in graph
				</button>
			</div>
			<HourlyChart rows={r.hourly} day={day} headsigns={[headsign(0), headsign(1)]} />
			<div className="row">
				{[0, 1]
					.filter((d) => r.patterns.some((p) => p.direction === d))
					.map((d) => (
						<button key={d} type="button" aria-pressed={dir === d} onClick={() => setDir(d)}>
							To {headsign(d)}
						</button>
					))}
			</div>
			{scenario ? (
				<EditForms
					scenario={scenario}
					route={r.route.gtfsId}
					direction={dir}
					day={day}
					onEdited={onEdited}
				/>
			) : (
				<p className="muted small">
					Fork a scenario and pick it above to edit this route's timetable.
				</p>
			)}
			<h3>
				{trips.length} {day} trips to {headsign(dir)}
			</h3>
			{main && (
				<div className="muted small">
					{main.stops.length} stops, {(main.lengthM / 1609).toFixed(1)} mi, {main.stops[0]?.name} to{' '}
					{main.stops[main.stops.length - 1]?.name}
				</div>
			)}
			<table className="timetable">
				<thead>
					<tr>
						<th>Departs</th>
						<th>Arrives</th>
						<th>Minutes</th>
						<th>Gap</th>
					</tr>
				</thead>
				<tbody>
					{trips.map((x, i) => (
						<tr key={x.id}>
							<td>{clock(x.start)}</td>
							<td>{clock(x.start + x.duration)}</td>
							<td>{Math.round(x.duration / 60)}</td>
							<td>{i ? Math.round((x.start - trips[i - 1]!.start) / 60) : ''}</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

const toSec = (hhmm: string) => {
	const [h, m] = hhmm.split(':').map(Number);
	return (h ?? 0) * 3600 + (m ?? 0) * 60;
};

function EditForms({
	scenario,
	route,
	direction,
	day,
	onEdited,
}: {
	scenario: Scenario;
	route: string;
	direction: number;
	day: Day;
	onEdited: (removed: boolean) => void;
}) {
	const [from, setFrom] = useState('07:00');
	const [to, setTo] = useState('09:00');
	const [minutes, setMinutes] = useState(10);
	const [shift, setShift] = useState(5);
	const [confirm, setConfirm] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const send = async (edit: Record<string, unknown>, removed = false) => {
		setBusy(true);
		setMsg(null);
		try {
			const r = await post<{ result: string }>(`/metro/scenarios/${scenario.id}/edits`, edit);
			setMsg(r.result);
			onEdited(removed);
		} catch (e) {
			setMsg((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="edit">
			<h3>Edit in {scenario.title}</h3>
			<form
				className="row"
				onSubmit={(e) => {
					e.preventDefault();
					void send({
						op: 'headway',
						route,
						direction,
						day,
						from: toSec(from),
						to: toSec(to),
						minutes,
					});
				}}
			>
				<span>Every</span>
				<input
					type="number"
					min={1}
					max={240}
					value={minutes}
					onChange={(e) => setMinutes(Number(e.target.value))}
					aria-label="Headway minutes"
				/>
				<span>min from</span>
				<input
					type="time"
					value={from}
					onChange={(e) => setFrom(e.target.value)}
					aria-label="From"
				/>
				<span>to</span>
				<input type="time" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
				<button type="submit" disabled={busy}>
					Set headway
				</button>
			</form>
			<form
				className="row"
				onSubmit={(e) => {
					e.preventDefault();
					void send({ op: 'shift', route, direction, day, minutes: shift });
				}}
			>
				<span>Move all {day} trips this direction by</span>
				<input
					type="number"
					min={-180}
					max={180}
					value={shift}
					onChange={(e) => setShift(Number(e.target.value))}
					aria-label="Shift minutes"
				/>
				<span>min</span>
				<button type="submit" disabled={busy}>
					Shift
				</button>
			</form>
			<div className="row">
				{confirm ? (
					<>
						<span>Remove the route, its patterns and every trip?</span>
						<button
							type="button"
							className="danger"
							disabled={busy}
							onClick={() => void send({ op: 'removeRoute', route }, true)}
						>
							Remove
						</button>
						<button type="button" onClick={() => setConfirm(false)}>
							Keep
						</button>
					</>
				) : (
					<button type="button" onClick={() => setConfirm(true)}>
						Remove route
					</button>
				)}
			</div>
			{msg && <div className="muted small">{msg}</div>}
		</div>
	);
}

function DraftPanel({
	draft,
	stopOf,
	scenario,
	onCancel,
	onSaved,
	onUndo,
}: {
	draft: string[];
	stopOf: Map<string, StopRow>;
	scenario: Scenario;
	onCancel: () => void;
	onSaved: () => void;
	onUndo: () => void;
}) {
	const [short, setShort] = useState('X1');
	const [long, setLong] = useState('');
	const [spans, setSpans] = useState([
		{ day: 'weekday' as Day, from: '06:00', to: '22:00', minutes: 15 },
	]);
	const [msg, setMsg] = useState<string | null>(null);
	const save = async () => {
		try {
			await post(`/metro/scenarios/${scenario.id}/edits`, {
				op: 'addRoute',
				short,
				long,
				stops: draft,
				spans: spans.map((s) => ({
					day: s.day,
					from: toSec(s.from),
					to: toSec(s.to),
					minutes: s.minutes,
				})),
			});
			onSaved();
		} catch (e) {
			setMsg((e as Error).message);
		}
	};
	return (
		<section>
			<h2>New route in {scenario.title}</h2>
			<div className="row">
				<input
					className="text short"
					value={short}
					onChange={(e) => setShort(e.target.value)}
					aria-label="Route number"
				/>
				<input
					className="text"
					placeholder="Description"
					value={long}
					onChange={(e) => setLong(e.target.value)}
				/>
			</div>
			<ol className="small">
				{draft.map((id) => (
					<li key={id}>{stopOf.get(id)?.name ?? id}</li>
				))}
			</ol>
			{draft.length < 2 && <p className="muted small">Pick at least two stops on the map.</p>}
			<h3>Service</h3>
			{spans.map((s, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: spans are edited in place
				<div className="row" key={i}>
					<select
						value={s.day}
						onChange={(e) =>
							setSpans(spans.map((x, k) => (k === i ? { ...x, day: e.target.value as Day } : x)))
						}
						aria-label="Day"
					>
						{DAYS.map((d) => (
							<option key={d}>{d}</option>
						))}
					</select>
					<input
						type="time"
						value={s.from}
						onChange={(e) =>
							setSpans(spans.map((x, k) => (k === i ? { ...x, from: e.target.value } : x)))
						}
						aria-label="From"
					/>
					<input
						type="time"
						value={s.to}
						onChange={(e) =>
							setSpans(spans.map((x, k) => (k === i ? { ...x, to: e.target.value } : x)))
						}
						aria-label="To"
					/>
					<span>every</span>
					<input
						type="number"
						min={1}
						value={s.minutes}
						onChange={(e) =>
							setSpans(
								spans.map((x, k) => (k === i ? { ...x, minutes: Number(e.target.value) } : x)),
							)
						}
						aria-label="Headway minutes"
					/>
					<span>min</span>
				</div>
			))}
			<div className="row">
				<button
					type="button"
					onClick={() =>
						setSpans([...spans, { day: 'saturday', from: '08:00', to: '20:00', minutes: 30 }])
					}
				>
					Add service span
				</button>
			</div>
			<div className="row">
				<button type="button" disabled={draft.length < 2} onClick={() => void save()}>
					Save route
				</button>
				<button type="button" disabled={!draft.length} onClick={onUndo}>
					Undo stop
				</button>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
			</div>
			{msg && <div className="error">{msg}</div>}
		</section>
	);
}

function StopPanel({
	stop,
	project,
	day,
	t,
	onBack,
	onRoute,
	onGraph,
}: {
	stop: string;
	project: string | null;
	day: Day;
	t: number;
	onBack: () => void;
	onRoute: (id: string) => void;
	onGraph: (c: Crumb) => void;
}) {
	const at = Math.floor(t / 300) * 300;
	const q = useQuery({
		queryKey: ['stop', project, stop, day, at],
		queryFn: () =>
			get<StopDetail>(
				withProject(`/metro/stop/${encodeURIComponent(stop)}?day=${day}&t=${at}`, project),
			),
		placeholderData: (prev) => prev,
	});
	if (q.isError) return <div className="error">{String(q.error)}</div>;
	const s = q.data;
	if (!s) return <div className="muted">Loading stop…</div>;
	return (
		<section>
			<button type="button" className="link" onClick={onBack}>
				Back to routes
			</button>
			<h2>{s.stop.name}</h2>
			<div className="muted small">
				Stop {s.stop.code} ·{' '}
				<button
					type="button"
					className="link"
					onClick={() => onGraph({ id: s.stop.id, type: 'stop', label: s.stop.name })}
				>
					Explore in graph
				</button>
			</div>
			<div className="row wrap">
				{s.routes.map((r) => (
					<button
						key={r.gtfsId}
						type="button"
						className="badge-button"
						onClick={() => onRoute(r.gtfsId)}
					>
						{r.short}
					</button>
				))}
			</div>
			<h3>
				Departures {clock(at)} to {clock(at + 7200)}, {day}
			</h3>
			<table className="timetable">
				<tbody>
					{s.departures.map((d, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: two trips can share route and minute
						<tr key={i}>
							<td>{clock(d.time)}</td>
							<td>{d.short}</td>
							<td>{d.headsign}</td>
						</tr>
					))}
				</tbody>
			</table>
			{!s.departures.length && <p className="muted small">No departures in this window.</p>}
		</section>
	);
}
