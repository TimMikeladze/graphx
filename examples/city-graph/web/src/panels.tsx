import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
	type Changes,
	type Compare,
	clock,
	type DayRow,
	dateOf,
	fmt,
	g,
	get,
	type IntersectionDetail,
	type Meta,
	minutes,
	post,
	type Scenario,
	type ZoneDetail,
} from './api.ts';
import { Bars, CrashYears, DayChart, TripChart, WindowChart } from './charts.tsx';
import { CONGESTION_STOPS, congestionColor } from './layers.ts';
import { minuteOf, useApp } from './state.ts';

const rgb = (c: ArrayLike<number>) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/** POST to one of graphx's generated routes for a project, as the dev principal. */
export async function graphPost<T>(
	meta: Meta,
	project: string,
	path: string,
	body: unknown,
): Promise<T> {
	const res = await fetch(`/t/${meta.tenant}/p/${project}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-user': meta.user, 'x-tenant': meta.tenant },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${path} → ${res.status}`);
	return (await res.json()) as T;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className="stat">
			<div className="stat-value">{value}</div>
			<div className="stat-label">{label}</div>
			{sub && <div className="stat-sub">{sub}</div>}
		</div>
	);
}

function Section({
	title,
	children,
	note,
}: {
	title: string;
	children?: React.ReactNode;
	note?: string;
}) {
	return (
		<section className="section">
			<h3>{title}</h3>
			{note && <p className="note">{note}</p>}
			{children}
		</section>
	);
}

export function CongestionLegend() {
	const { theme } = useApp();
	return (
		<div className="legend-ramp" aria-label="Congestion colour scale">
			{CONGESTION_STOPS.map((s) => (
				<span
					key={s}
					style={{ background: rgb(congestionColor(s, theme) as unknown as number[]) }}
				/>
			))}
			<div className="legend-ends">
				<span>free flow</span>
				<span>3× slower</span>
			</div>
		</div>
	);
}

// --- Q1 traffic ---------------------------------------------------------------------------------
export function TrafficPanel() {
	const { meta, t, project, scenario } = useApp();
	const base = useQuery({
		queryKey: ['day', meta.project],
		queryFn: () => get<DayRow[]>('/city/day'),
	});
	const scen = useQuery({
		queryKey: ['day-scenario', project],
		enabled: !!scenario && scenario.status === 'done',
		queryFn: () => get<DayRow[]>('/city/day', { project }),
	});
	const now = base.data?.find((r) => r.t === t);
	const peak = base.data?.reduce((a, b) => (b.slowdown > a.slowdown ? b : a), base.data[0]!);
	return (
		<>
			<Section
				title="Boston, all day"
				note="Every drivable street, modelled for one weekday. Colour shows how much slower than free flow each road runs at the selected time."
			>
				<div className="stats">
					<Stat
						label="vehicles on the road"
						value={now ? fmt.format(now.vehicles) : '…'}
						sub={`at ${clock(t)}`}
					/>
					<Stat label="slower than free flow" value={now ? `${now.slowdown.toFixed(2)}×` : '…'} />
					<Stat
						label="worst window"
						value={peak ? minutes(peak.start) : '…'}
						sub={peak ? `${peak.slowdown.toFixed(2)}×` : ''}
					/>
				</div>
				<CongestionLegend />
				{base.data && <DayChart base={base.data} scenario={scen.data} now={minuteOf(meta, t)} />}
			</Section>
			<Section title="The graph behind it">
				<ul className="facts">
					<li>
						<b>{fmt.format(meta.counts.intersections!)}</b> intersections,{' '}
						<b>{fmt.format(meta.counts.segments!)}</b> directed road segments (OpenStreetMap)
					</li>
					<li>
						<b>{fmt.format(meta.counts.signals!)}</b> city traffic signals, timing synthesised
					</li>
					<li>
						<b>{fmt.format(meta.counts.commuters!)}</b> commuters in{' '}
						<b>{fmt.format(meta.counts.zones!)}</b> block groups (census LODES)
					</li>
					<li>
						<b>{fmt.format(meta.baseline.roadVersions)}</b> road versions: one per segment per
						window it changed
					</li>
					<li>
						<b>{fmt.format(meta.counts.crashes!)}</b> crashes since 2015 ·{' '}
						<b>{fmt.format(meta.counts.reports!)}</b> street 311 cases in 2026
					</li>
				</ul>
				<p className="note">
					Click a road or a dot for details. Scrub the time bar, or press play.
				</p>
			</Section>
		</>
	);
}

// --- intersection detail (Q3, Q6) ---------------------------------------------------------------
export function IntersectionPanel({ id }: { id: string }) {
	const { meta, t, project, select, setTab, draft, setDraft } = useApp();
	const q = useQuery({
		queryKey: ['intersection', id, t, project],
		queryFn: () => get<IntersectionDetail>(`/city/intersection/${id}`, { t, project }),
	});
	const [measure, setMeasure] = useState<'delaySec' | 'volume'>('delaySec');
	const d = q.data;
	if (q.isError) return <p className="error">{String(q.error)}</p>;
	if (!d) return <p className="loading">Loading intersection…</p>;
	const crashYears = new Map<string, { Vehicle: number; Cyclist: number; Pedestrian: number }>();
	for (const c of d.crashes) {
		const y = String(new Date(c.at).getFullYear());
		const row = crashYears.get(y) ?? { Vehicle: 0, Cyclist: 0, Pedestrian: 0 };
		row[c.mode === 'ped' ? 'Pedestrian' : c.mode === 'bike' ? 'Cyclist' : 'Vehicle']++;
		crashYears.set(y, row);
	}
	const crashRows = [...crashYears]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.flatMap(([year, r]) =>
			(['Vehicle', 'Cyclist', 'Pedestrian'] as const).map((mode) => ({
				year,
				mode,
				count: r[mode],
			})),
		);
	const retime = () => {
		if (!d.signal) return;
		setDraft({
			...draft,
			signals: {
				...draft.signals,
				[d.key]: { cycleSec: d.signal.cycleSec, green: { ...d.signal.green } },
			},
		});
		setTab('scenarios');
	};
	const rank = (r: { rank: number } | null) => (r ? `#${fmt.format(r.rank)}` : '—');
	return (
		<>
			<Section title={d.name}>
				<button type="button" className="link" onClick={() => select(null)}>
					← back
				</button>
				<div className="stats">
					<Stat
						label="busiest-route rank"
						value={rank(d.ranks.betweenness)}
						sub="betweenness at 08:00"
					/>
					<Stat label="volume rank" value={rank(d.ranks.volume)} />
					<Stat label="crash-risk rank" value={rank(d.ranks.risk)} />
				</div>
			</Section>
			{d.signal ? (
				<Section
					title={`Signal · ${d.signal.cycleSec}s cycle`}
					note={
						d.signal.synthetic
							? 'Location from the city signal inventory; timing synthesised (not published).'
							: undefined
					}
				>
					<Bars
						rows={Object.entries(d.signal.green).map(([label, value]) => ({ label, value }))}
						unit="s of green"
						ariaLabel="Green time per approach"
					/>
					{d.versions.length > 1 && (
						<p className="note">
							{d.versions.length} versions of this intersection — retimed{' '}
							{dateOf(d.versions[d.versions.length - 1]!.validFrom)}.
						</p>
					)}
					<button type="button" onClick={retime}>
						Retime this signal in a scenario →
					</button>
				</Section>
			) : (
				<Section title="No signal" note="Not in the city's signal inventory." />
			)}
			<Section title="Across the day">
				<div className="toggle">
					<button
						type="button"
						aria-pressed={measure === 'delaySec'}
						onClick={() => setMeasure('delaySec')}
					>
						Delay
					</button>
					<button
						type="button"
						aria-pressed={measure === 'volume'}
						onClick={() => setMeasure('volume')}
					>
						Volume
					</button>
				</div>
				<WindowChart rows={d.byWindow} measure={measure} now={minuteOf(meta, t)} />
				<table className="table">
					<thead>
						<tr>
							<th>Approach at {clock(t)}</th>
							<th>veh/h</th>
							<th>sec</th>
						</tr>
					</thead>
					<tbody>
						{d.approaches.map((a) => (
							<tr key={a.id}>
								<td>{a.street}</td>
								<td>{fmt.format(a.volume)}</td>
								<td>
									{Math.round(a.seconds)}{' '}
									<span className="muted">/ {Math.round(a.freeFlowSec)}</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</Section>
			{d.signal && (
				<Section
					title={`Who drives through · ${fmt.format(d.passing.drivers)} commuters`}
					note="Commutes whose 08:00 route passes this light, by home neighbourhood."
				>
					{d.passing.neighborhoods.length ? (
						<Bars
							rows={d.passing.neighborhoods
								.slice(0, 10)
								.map((n) => ({ label: n.name, value: n.drivers }))}
							unit="drivers"
							ariaLabel="Commuters through this light by home neighbourhood"
						/>
					) : (
						<p className="note">No modelled commute passes here.</p>
					)}
				</Section>
			)}
			<Section
				title={`Crashes · ${d.crashes.length}`}
				note="Vision Zero crash records within 60 m, by year."
			>
				{crashRows.length > 0 && (
					<CrashYears rows={crashRows} ariaLabel="Crashes at this intersection by year and mode" />
				)}
			</Section>
			{d.reports.length > 0 && (
				<Section title={`Open 311 cases at ${clock(t)} · ${d.reports.length}`}>
					<ul className="list">
						{d.reports.slice(0, 8).map((r) => (
							<li key={r.id}>
								{r.type} <span className="muted">· {dateOf(r.openedAt)}</span>
							</li>
						))}
					</ul>
				</Section>
			)}
		</>
	);
}

// --- Q2 route ------------------------------------------------------------------------------------
export function RoutePanel() {
	const { meta, t, project, route, setRoute, intersections } = useApp();
	const body = {
		src: route.from ?? '',
		dst: route.to ?? '',
		rels: ['road'],
		types: ['intersection'],
		asOf: t,
	};
	const path = g.useShortestPath(body);
	const hours = meta.windows.filter((w) => w.start % 60 === 0);
	const day = useQueries({
		queries: hours.map((w) => ({
			queryKey: ['trip', project, route.from, route.to, w.t],
			enabled: !!route.from && !!route.to,
			queryFn: () =>
				graphPost<{ cost: number } | null>(meta, project, '/algorithms/shortest-path', {
					...body,
					asOf: w.t,
				}),
		})),
	});
	const tripRows = day.flatMap((q, i) =>
		q.data ? [{ start: hours[i]!.start, minutes: q.data.cost / 60 }] : [],
	);
	const name = (id: string | null) => (id ? (intersections.get(id)?.name ?? id) : 'click the map');
	return (
		<Section
			title="Fastest drive"
			note="graphx shortestPath over the road versions valid at the selected time — the same trip prices differently at 08:00 and at midnight."
		>
			<div className="route-ends">
				<div>
					<span className="dot a" /> {name(route.from)}
				</div>
				<div>
					<span className="dot b" /> {name(route.to)}
				</div>
			</div>
			{route.from && route.to ? (
				path.data ? (
					<div className="stats">
						<Stat label={`leaving ${clock(t)}`} value={`${(path.data.cost / 60).toFixed(1)} min`} />
						<Stat label="intersections" value={String(path.data.path.length)} />
					</div>
				) : (
					<p className="loading">{path.isFetching ? 'Routing…' : 'No route.'}</p>
				)
			) : (
				<p className="note">Click a start and an end intersection on the map.</p>
			)}
			{tripRows.length > 2 && <TripChart rows={tripRows} now={minuteOf(meta, t)} />}
			{(route.from || route.to) && (
				<button type="button" className="link" onClick={() => setRoute({ from: null, to: null })}>
					Clear route
				</button>
			)}
		</Section>
	);
}

// --- Q3 commutes -----------------------------------------------------------------------------------
export function CommutesPanel() {
	const { selected, project, flyTo } = useApp();
	const key = selected?.kind === 'zone' ? selected.key : null;
	const q = useQuery({
		queryKey: ['zone', key, project],
		enabled: !!key,
		queryFn: () => get<ZoneDetail>(`/city/zone/${key}`, { project }),
	});
	if (!key) {
		return (
			<Section
				title="Commutes"
				note="Census LODES 2023: who lives where and works where. Shading is the number of commuters living in each block group. Click a block group."
			/>
		);
	}
	const z = q.data;
	if (!z) return <p className="loading">Loading…</p>;
	const avg = (list: ZoneDetail['outbound']) => {
		const d = list.reduce((s, c) => s + c.drivers, 0);
		return d ? list.reduce((s, c) => s + c.amMinutes * c.drivers, 0) / d : 0;
	};
	return (
		<>
			<Section title={z.name}>
				<div className="stats">
					<Stat label="morning drive out, avg" value={`${avg(z.outbound).toFixed(1)} min`} />
					<Stat label="drive in, avg" value={`${avg(z.inbound).toFixed(1)} min`} />
				</div>
			</Section>
			<Section
				title="Where residents drive to"
				note="Top work destinations by drivers; arcs on the map."
			>
				<table className="table">
					<tbody>
						{z.outbound.slice(0, 12).map((c) => (
							<tr key={c.work} onClick={() => c.other && flyTo(c.other.lng, c.other.lat, 13)}>
								<td>{c.other?.name ?? c.work}</td>
								<td>{c.drivers.toFixed(0)} drivers</td>
								<td>{c.amMinutes.toFixed(0)}′</td>
							</tr>
						))}
					</tbody>
				</table>
			</Section>
			<Section title="Who drives in to work here">
				<table className="table">
					<tbody>
						{z.inbound.slice(0, 12).map((c) => (
							<tr key={c.home}>
								<td>{c.other?.name ?? c.home}</td>
								<td>{c.drivers.toFixed(0)} drivers</td>
								<td>{c.amMinutes.toFixed(0)}′</td>
							</tr>
						))}
					</tbody>
				</table>
			</Section>
		</>
	);
}

// --- Q4 scenarios ------------------------------------------------------------------------------------
export function ScenarioPanel() {
	const { meta, scenarios, scenario, setScenario, draft, setDraft, t, network, intersections } =
		useApp();
	const qc = useQueryClient();
	const [title, setTitle] = useState('');
	const [busy, setBusy] = useState(false);
	const compare = useQuery({
		queryKey: ['compare', scenario?.project, t],
		enabled: !!scenario && scenario.status === 'done',
		queryFn: () => get<Compare>('/city/compare', { project: scenario!.project, t }),
	});
	const draftCount =
		Object.keys(draft.signals ?? {}).length +
		(draft.closed?.length ?? 0) +
		Object.keys(draft.lanes ?? {}).length +
		Object.keys(draft.jobs ?? {}).length;
	const run = async () => {
		setBusy(true);
		try {
			await post('/city/scenarios', { title: title || 'Untitled scenario', edits: draft });
			setDraft({});
			setTitle('');
			await qc.invalidateQueries({ queryKey: ['scenarios'] });
		} finally {
			setBusy(false);
		}
	};
	const byKey = useMemo(() => new Map(network.segments.map((s) => [s.key, s])), [network]);
	const signalName = (key: string) =>
		[...intersections.values()].find((i) => i.key === key)?.name ?? key;
	const c = compare.data;
	return (
		<>
			<Section
				title="Scenario lab"
				note="A scenario forks the city as it stood just before the modelled day and replays the day with your edits. The baseline is never touched; each branch is its own graphx project."
			>
				<ul className="list scenarios">
					<li>
						<button type="button" aria-pressed={!scenario} onClick={() => setScenario(null)}>
							Baseline
						</button>
					</li>
					{scenarios.map((s) => (
						<li key={s.id}>
							<button
								type="button"
								aria-pressed={scenario?.id === s.id}
								disabled={s.status !== 'done'}
								onClick={() => setScenario(s)}
							>
								{s.title}
							</button>
							{s.status === 'running' && <progress value={s.progress} max={1} />}
							{s.status === 'failed' && <span className="error"> failed: {s.summary?.error}</span>}
						</li>
					))}
				</ul>
			</Section>
			{scenario && c && (
				<Section
					title={`vs baseline at ${clock(t)}`}
					note="Map: blue roads got faster, red slower; thick red roads are closed. Zones with 25+ drivers."
				>
					<div className="stats">
						<Stat
							label="vehicle-hours over the day"
							value={`${c.totals.vehicleHoursScenario - c.totals.vehicleHoursBase > 0 ? '+' : ''}${fmt.format(c.totals.vehicleHoursScenario - c.totals.vehicleHoursBase)}`}
							sub={`of ${fmt.format(c.totals.vehicleHoursBase)}`}
						/>
						<Stat
							label="commuter-hours / day"
							value={`${c.totals.commuteHoursDelta > 0 ? '+' : ''}${fmt.format(c.totals.commuteHoursDelta)}`}
						/>
						<Stat
							label="roads changed"
							value={fmt.format(c.delta.filter((d) => d !== null && Math.abs(d) >= 1).length)}
							sub={`${c.closed.length} closed`}
						/>
					</div>
					<h4>Who wins (minutes per driver per day)</h4>
					<Bars
						rows={c.zones.slice(0, 6).map((z) => ({ label: z.name, value: z.deltaMinutes }))}
						unit="min"
						signed
						ariaLabel="Home zones whose commute got shorter"
					/>
					<h4>Who pays</h4>
					<Bars
						rows={c.zones
							.slice(-6)
							.reverse()
							.map((z) => ({ label: z.name, value: z.deltaMinutes }))}
						unit="min"
						signed
						ariaLabel="Home zones whose commute got longer"
					/>
				</Section>
			)}
			<Section
				title="New scenario"
				note="Click a road on the map to close it or take a lane; open a signalised intersection to retime it."
			>
				{draftCount === 0 ? (
					<p className="note">No edits yet.</p>
				) : (
					<ul className="list">
						{Object.entries(draft.signals ?? {}).map(([key, plan]) => (
							<li key={key}>
								<b>Retime</b> {signalName(key)}
								{Object.entries(plan.green).map(([street, sec]) => (
									<label key={street} className="slider">
										{street} <span>{sec}s</span>
										<input
											type="range"
											min={8}
											max={plan.cycleSec - 12}
											value={sec}
											onChange={(e) =>
												setDraft({
													...draft,
													signals: {
														...draft.signals,
														[key]: {
															...plan,
															green: rebalance(plan, street, Number(e.target.value)),
														},
													},
												})
											}
										/>
									</label>
								))}
							</li>
						))}
						{(draft.closed ?? []).map((k) => (
							<li key={k}>
								<b>Close</b> {byKey.get(k)?.street ?? k}{' '}
								<button
									type="button"
									className="link"
									onClick={() =>
										setDraft({ ...draft, closed: draft.closed!.filter((x) => x !== k) })
									}
								>
									undo
								</button>
							</li>
						))}
						{Object.entries(draft.lanes ?? {}).map(([k, lanes]) => (
							<li key={k}>
								<b>
									{lanes} lane{lanes === 1 ? '' : 's'}
								</b>{' '}
								on {byKey.get(k)?.street ?? k}
							</li>
						))}
						{Object.entries(draft.jobs ?? {}).map(([k, n]) => (
							<li key={k}>
								<b>+{fmt.format(n)} jobs</b> in {k}
							</li>
						))}
					</ul>
				)}
				<input
					className="text"
					placeholder="Scenario title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<button type="button" disabled={draftCount === 0 || busy} onClick={run}>
					{busy ? 'Starting…' : 'Fork the city and replay the day →'}
				</button>
				<p className="note">
					Takes about two minutes: fork, then 48 windows of traffic assignment across worker
					threads.
				</p>
			</Section>
			{meta && null}
		</>
	);
}

/**
 * Set one approach's green and rescale the others to fill what is left of the cycle (4 s lost
 * per phase, never under 8 s), so a plan always adds up.
 */
function rebalance(
	plan: { cycleSec: number; green: Record<string, number> },
	street: string,
	sec: number,
): Record<string, number> {
	const others = Object.keys(plan.green).filter((s) => s !== street);
	const usable = plan.cycleSec - 4 * Math.max(2, others.length + 1);
	const v = Math.min(sec, usable - 8 * others.length);
	const rest = usable - v;
	const was = others.reduce((t, s) => t + (plan.green[s] ?? 0), 0) || others.length;
	const green: Record<string, number> = { [street]: v };
	for (const s of others) green[s] = Math.max(8, Math.round((rest * (plan.green[s] ?? 1)) / was));
	return green;
}

// --- Q5 critical --------------------------------------------------------------------------------------
const CRITICAL = {
	betweenness: {
		label: 'Most routes through it',
		note: 'Betweenness at 08:00: share of shortest paths across the city that pass this intersection (graphx betweenness, asOf the peak, persisted as a score).',
	},
	volume: {
		label: 'Busiest',
		note: 'Vehicles per hour entering at 08:00, summed from the road versions valid then.',
	},
	pagerank: { label: 'Where routes converge', note: 'PageRank over the road network as of 08:00.' },
} as const;
export function CriticalPanel({
	metric,
	setMetric,
}: {
	metric: keyof typeof CRITICAL;
	setMetric(m: keyof typeof CRITICAL): void;
}) {
	const { meta, intersections, select, flyTo } = useApp();
	const top = g.useTopNodes({
		by: `score:${meta.scores[metric]}`,
		type: 'intersection',
		limit: 25,
	});
	return (
		<Section title="Critical intersections" note={CRITICAL[metric].note}>
			<div className="toggle">
				{(Object.keys(CRITICAL) as Array<keyof typeof CRITICAL>).map((m) => (
					<button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)}>
						{CRITICAL[m].label}
					</button>
				))}
			</div>
			<ol className="ranked">
				{(top.data ?? []).map((r) => {
					const i = intersections.get(r.id);
					return (
						<li key={r.id}>
							<button
								type="button"
								className="link"
								onClick={() => {
									select({ kind: 'intersection', id: r.id });
									if (i) flyTo(i.lng, i.lat);
								}}
							>
								{i?.name ?? r.id}
							</button>
							<span className="muted">
								{metric === 'volume'
									? `${fmt.format(Math.round(r.score ?? 0))} veh/h`
									: (r.score ?? 0).toFixed(3)}
							</span>
						</li>
					);
				})}
			</ol>
		</Section>
	);
}

// --- Q6 safety ------------------------------------------------------------------------------------------
export function SafetyPanel({
	crashes,
}: {
	crashes: Array<[number, number, number, number]> | undefined;
}) {
	const { meta, intersections, select, flyTo } = useApp();
	const top = g.useTopNodes({ by: `score:${meta.scores.risk}`, type: 'intersection', limit: 15 });
	const rows = useMemo(() => {
		const m = new Map<string, [number, number, number]>();
		for (const [, , mode, at] of crashes ?? []) {
			const y = String(new Date(at).getFullYear());
			const r = m.get(y) ?? [0, 0, 0];
			r[mode]!++;
			m.set(y, r);
		}
		return [...m]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.flatMap(([year, r]) => [
				{ year, mode: 'Vehicle', count: r[0] },
				{ year, mode: 'Cyclist', count: r[1] },
				{ year, mode: 'Pedestrian', count: r[2] },
			]);
	}, [crashes]);
	return (
		<>
			<Section
				title="Where people get hurt"
				note="Vision Zero crash records since 2015 — every crash a node, valid from when it happened. The map shows density, weighted toward pedestrians and cyclists."
			>
				{rows.length > 0 && <CrashYears rows={rows} ariaLabel="Boston crashes per year by mode" />}
			</Section>
			<Section
				title="Highest crash risk"
				note="Pedestrian ×3, cyclist ×2, vehicle ×1 over the three years before the modelled day."
			>
				<ol className="ranked">
					{(top.data ?? []).map((r) => {
						const i = intersections.get(r.id);
						return (
							<li key={r.id}>
								<button
									type="button"
									className="link"
									onClick={() => {
										select({ kind: 'intersection', id: r.id });
										if (i) flyTo(i.lng, i.lat);
									}}
								>
									{i?.name ?? r.id}
								</button>
								<span className="muted">{(r.score ?? 0).toFixed(2)}</span>
							</li>
						);
					})}
				</ol>
			</Section>
		</>
	);
}

// --- Q7 transit ---------------------------------------------------------------------------------------
export function TransitPanel({
	live,
	observed,
}: {
	live: { count: number; hops: number; error: string | null };
	observed: Array<{ route: string; ratio: number; n: number }>;
}) {
	return (
		<>
			<Section
				title="Buses, live"
				note="Positions stream from the MBTA every 15 s and are never stored. When a bus reaches its next stop, the seconds it took become a new version of that stop-to-stop link."
			>
				<div className="stats">
					<Stat label="buses on the map" value={fmt.format(live.count)} />
					<Stat
						label="hops recorded"
						value={fmt.format(live.hops)}
						sub="since the server started"
					/>
				</div>
				{live.error && <p className="error">MBTA: {live.error}</p>}
			</Section>
			<Section
				title="Slowest against schedule"
				note="Observed ÷ scheduled time on links measured so far."
			>
				{observed.length ? (
					<Bars
						rows={observed
							.slice(0, 10)
							.map((o) => ({ label: `Route ${o.route}`, value: Math.round(o.ratio * 100) / 100 }))}
						unit="× schedule"
						ariaLabel="Bus routes running slowest against schedule"
					/>
				) : (
					<p className="note">No hops measured yet — give it a few minutes.</p>
				)}
			</Section>
		</>
	);
}

// --- Q8 what changed ------------------------------------------------------------------------------------
export function ChangesPanel({
	data,
	range,
	setRange,
}: {
	data: Changes | undefined;
	range: 'day' | 'week' | 'month';
	setRange(r: 'day' | 'week' | 'month'): void;
}) {
	const { t } = useApp();
	return (
		<Section
			title="What changed"
			note="graphx diff: every version that opened or closed in the window ending at the selected time."
		>
			<div className="toggle">
				{(['day', 'week', 'month'] as const).map((r) => (
					<button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
						Last {r}
					</button>
				))}
			</div>
			{data ? (
				<>
					<p className="note">
						{dateOf(data.t1)} → {dateOf(t)}
					</p>
					<table className="table">
						<thead>
							<tr>
								<th>type</th>
								<th>opened</th>
								<th>closed</th>
							</tr>
						</thead>
						<tbody>
							{Object.entries(data.nodes).map(([k, v]) => (
								<tr key={k}>
									<td>{k}</td>
									<td>{fmt.format(v.opened)}</td>
									<td>{fmt.format(v.closed)}</td>
								</tr>
							))}
							{Object.entries(data.edges).map(([k, v]) => (
								<tr key={k}>
									<td className="muted">{k} (edge)</td>
									<td>{fmt.format(v.opened)}</td>
									<td>{fmt.format(v.closed)}</td>
								</tr>
							))}
						</tbody>
					</table>
					<h4>New 311 cases</h4>
					<ul className="list">
						{data.reports.slice(0, 10).map((r) => (
							<li key={r.id}>
								{r.type} <span className="muted">· {r.street}</span>
							</li>
						))}
					</ul>
				</>
			) : (
				<p className="loading">Diffing…</p>
			)}
		</Section>
	);
}

export type { Scenario };
