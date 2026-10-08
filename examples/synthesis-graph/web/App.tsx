import { useEffect, useMemo, useState } from 'react';
import {
	api,
	type Meta,
	type Objective,
	type Plan,
	type Route,
	type State,
	type TimelineRow,
	type Version,
} from './api.ts';
import { CostChart, EfficiencyChart, StepsChart } from './charts.tsx';
import { Network } from './Network.tsx';
import { routeColors, useMode } from './palette.ts';

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const usd = (v: number) => `$${v.toFixed(0)}`;
const yearOf = (ms: number) => new Date(ms).getUTCFullYear();

function RouteBadges({ routes, colors }: { routes: string[]; colors: Record<Route, string> }) {
	return (
		<span className="badges">
			{routes.map((r) => (
				<span key={r} className="badge">
					<i style={{ background: colors[r as Route] }} />
					{r}
				</span>
			))}
		</span>
	);
}

function Stats({ plan }: { plan: Plan }) {
	return (
		<dl className="stats">
			<div>
				<dt>Steps</dt>
				<dd>{plan.lls}</dd>
			</div>
			<div>
				<dt>Overall yield</dt>
				<dd>{pct(plan.overallYield)}</dd>
			</div>
			<div>
				<dt>Cost / mol</dt>
				<dd>{usd(plan.cost)}</dd>
			</div>
			<div>
				<dt>Atom economy</dt>
				<dd>{pct(plan.atomEconomy)}</dd>
			</div>
		</dl>
	);
}

export function App() {
	const mode = useMode();
	const colors = useMemo(() => routeColors(mode), [mode]);
	const ink = mode === 'dark' ? '#f5f3ea' : '#0b0b0b';
	const [meta, setMeta] = useState<Meta | null>(null);
	const [run, setRun] = useState('baseline');
	const [objective, setObjective] = useState<Objective>('cost');
	const [avoid, setAvoid] = useState(false);
	const [year, setYear] = useState(2026);
	const [state, setState] = useState<State | null>(null);
	const [timeline, setTimeline] = useState<TimelineRow[]>([]);
	const [playing, setPlaying] = useState(false);
	const [selected, setSelected] = useState<string | null>('F2');
	const [history, setHistory] = useState<Version[]>([]);
	const [cut, setCut] = useState<string[]>(['ac2o']);
	const [forking, setForking] = useState(false);
	const [compare, setCompare] = useState<{ base: State; branch: State; label: string } | null>(
		null,
	);

	const q = useMemo(() => ({ run, objective, avoid }), [run, objective, avoid]);

	useEffect(() => {
		api.meta().then(setMeta);
	}, []);

	useEffect(() => {
		let live = true;
		api.state(q, year).then((s) => live && setState(s));
		return () => {
			live = false;
		};
	}, [q, year]);

	useEffect(() => {
		api.timeline(q).then(setTimeline);
	}, [q]);

	useEffect(() => {
		if (selected) api.versions(run, selected).then(setHistory);
	}, [run, selected]);

	// The newest what-if, planned today against the baseline with the same objective.
	const branch = meta?.runs.filter((r) => r.id !== 'baseline').at(-1);
	useEffect(() => {
		if (!branch || !meta) return setCompare(null);
		Promise.all([
			api.state({ run: 'baseline', objective, avoid }, meta.lastYear),
			api.state({ run: branch.id, objective, avoid }, meta.lastYear),
		]).then(([base, br]) => setCompare({ base, branch: br, label: branch.label }));
	}, [branch?.id, objective, avoid, meta]);

	// Advance one year at a time, only after the previous year's read has landed.
	useEffect(() => {
		if (!playing || !state || !meta) return;
		if (state.year >= meta.lastYear) return setPlaying(false);
		const id = setTimeout(() => setYear((y) => y + 1), 140);
		return () => clearTimeout(id);
	}, [playing, state, meta]);

	if (!meta) return <main className="loading">Loading the synthesis graph…</main>;

	const span = meta.lastYear - meta.firstYear;
	const plan = state?.plan ?? null;
	const nameOf = (id: string) =>
		meta.molecules.find((m) => m.id === id)?.name ??
		meta.reactions.find((r) => r.id === id)?.id ??
		id;
	const pathText = (path: string[]) =>
		path.filter((id) => meta.reactions.some((r) => r.id === id)).join(' → ');
	const buyable = meta.molecules.filter((m) => m.price !== null && m.id !== 'ibb');

	const fork = async () => {
		setForking(true);
		try {
			const { id } = await api.whatIf(cut);
			const next = await api.meta();
			setMeta(next);
			setRun(id);
			setYear(next.lastYear);
		} finally {
			setForking(false);
		}
	};

	return (
		<main>
			<header>
				<p className="eyebrow">graphx example · synthesis-graph</p>
				<h1>How would you make ibuprofen {year >= meta.lastYear ? 'today' : `in ${year}`}?</h1>
				<p className="lede">
					Molecules and reactions are nodes in one graph. The Boots (1961), BHC (1992) and flow
					(2009, improved 2015) routes enter it on the date they were published, so “what was the
					best route then” is a graphx read <em>as of</em> that date. A route planner runs on
					whatever the read returns.
				</p>
			</header>

			<section className="controls" aria-label="Date and planning options">
				<button
					type="button"
					className="play"
					onClick={() => {
						if (!playing && year >= meta.lastYear) setYear(meta.firstYear);
						setPlaying((p) => !p);
					}}
					aria-label={playing ? 'Pause' : 'Play through history'}
				>
					{playing ? '❚❚' : '▶'}
				</button>
				<div className="scrubber">
					<input
						type="range"
						min={meta.firstYear}
						max={meta.lastYear}
						value={year}
						onChange={(e) => {
							setPlaying(false);
							setYear(Number(e.target.value));
						}}
						aria-label="Year"
					/>
					<div className="ticks" aria-hidden="true">
						{meta.events.map((e) => (
							<button
								type="button"
								key={e.year}
								style={{ left: `${((e.year - meta.firstYear) / span) * 100}%` }}
								className={year >= e.year ? 'tick on' : 'tick'}
								onClick={() => {
									setPlaying(false);
									setYear(e.year);
								}}
							>
								<span>{e.year}</span>
								{e.label}
							</button>
						))}
					</div>
				</div>
				<output className="clock">{year >= meta.lastYear ? 'Now' : year}</output>
			</section>

			<section className="options" aria-label="Planner">
				<div className="seg" role="radiogroup" aria-label="Objective">
					{(['cost', 'steps'] as const).map((o) => (
						<button
							type="button"
							key={o}
							role="radio"
							aria-checked={objective === o}
							className={objective === o ? 'on' : ''}
							onClick={() => setObjective(o)}
						>
							{o === 'cost' ? 'Cheapest' : 'Fewest steps'}
						</button>
					))}
				</div>
				<label className="toggle">
					<input type="checkbox" checked={avoid} onChange={(e) => setAvoid(e.target.checked)} />
					Avoid severe hazards (HF, CO, Raney Ni)
				</label>
				<select value={run} onChange={(e) => setRun(e.target.value)} aria-label="Graph">
					{meta.runs.map((r) => (
						<option key={r.id} value={r.id}>
							{r.id === 'baseline' ? 'Baseline graph' : `What-if: ${r.label}`}
						</option>
					))}
				</select>
			</section>

			<section className="stage">
				<figure className="card net-card">
					{state ? (
						<Network
							meta={meta}
							state={state}
							colors={colors}
							selected={selected}
							onSelect={setSelected}
						/>
					) : (
						<div className="loading">reading…</div>
					)}
					<figcaption>
						<span className="legend">
							{(['Boots', 'BHC', 'Flow'] as Route[]).map((r) => (
								<span key={r} className="badge">
									<i style={{ background: colors[r] }} />
									{r}
								</span>
							))}
						</span>
						<span className="muted">
							Lit: best route. Faded: not known yet. ⚠ severe hazard. Click a reaction for its
							history.
						</span>
					</figcaption>
				</figure>

				<aside className="card route">
					{plan ? (
						<>
							<h2>
								Best route <RouteBadges routes={plan.routes} colors={colors} />
							</h2>
							<Stats plan={plan} />
							<ol className="steps">
								{plan.steps.map((s) => (
									<li key={s.id}>
										<button type="button" onClick={() => setSelected(s.id)}>
											<b>{s.name}</b>
											<span className="muted">
												{' '}
												{s.conditions} · {pct(s.yield)}
											</span>
										</button>
									</li>
								))}
							</ol>
							<p className="muted small">
								Buy:{' '}
								{plan.buy.map((b) => (b.mol === 1 ? b.name : `${b.mol} × ${b.name}`)).join(', ')}
							</p>
						</>
					) : (
						<>
							<h2>No route yet</h2>
							<p className="muted">
								{year < 1961
									? 'Nothing in the graph reaches ibuprofen before the Boots patent (1961).'
									: 'Nothing in this graph reaches ibuprofen with these constraints.'}
							</p>
						</>
					)}

					{selected && history.length > 0 && (
						<div className="history">
							<h3>
								{selected} · {history[0]!.data.name}
							</h3>
							<p className="muted small">
								<code>history('{selected}')</code>, {history.length} version
								{history.length > 1 ? 's' : ''}
							</p>
							<ul>
								{history.map((v) => (
									<li key={v.from}>
										<span className="mono">{yearOf(v.from)}</span> {pct(v.data.yield)} ·{' '}
										{v.data.conditions}
										<br />
										<span className="muted small">{v.data.ref}</span>
									</li>
								))}
							</ul>
						</div>
					)}
				</aside>
			</section>

			<section className="card">
				<h2>The best route, year by year</h2>
				<p className="muted small">
					The planner run on an <code>asOf</code> read of every year from {meta.firstYear}. Click a
					chart to jump to that year.
				</p>
				<div className="multiples">
					<StepsChart rows={timeline} year={year} ink={ink} onPick={setYear} />
					<EfficiencyChart
						rows={timeline}
						year={year}
						colors={[colors.BHC, colors.Boots]}
						onPick={setYear}
					/>
					<CostChart rows={timeline} year={year} ink={ink} onPick={setYear} />
				</div>
			</section>

			<section className="trio">
				<div className="card">
					<h2>What the last event added</h2>
					<p className="muted small">
						<code>diff</code> up to{' '}
						{state?.lastEvent ? `${state.lastEvent.year} · ${state.lastEvent.label}` : '—'}
					</p>
					<ul className="plain">
						{state?.changed.map((c) => (
							<li key={`${c.id}${c.yield}`}>
								<span className="mono">{c.id}</span> {c.name}
								{c.yield !== undefined && <span className="muted"> · {pct(c.yield)}</span>}
							</li>
						))}
						{state && state.changed.length === 0 && <li className="muted">Nothing yet.</li>}
					</ul>
				</div>
				<div className="card">
					<h2>Severe hazards in the graph</h2>
					<p className="muted small">
						<code>match</code>: reaction ↔ molecule where severity = severe
					</p>
					<ul className="plain">
						{state?.hazards.map((h) => (
							<li key={`${h.reaction}${h.molecule}`}>
								<span className="mono">{h.reaction}</span> {h.molecule}{' '}
								<span className="muted">· {h.hazard}</span>
							</li>
						))}
						{state && state.hazards.length === 0 && <li className="muted">None known.</li>}
					</ul>
				</div>
				<div className="card">
					<h2>Straight-line paths</h2>
					<p className="muted small">
						<code>shortestPath</code> isobutylbenzene → ibuprofen. One chain, ignores co-reactants.
					</p>
					<ul className="plain">
						<li>
							Fewest hops:{' '}
							{state?.chains.fewestSteps
								? `${state.chains.fewestSteps.steps} steps · ${pathText(state.chains.fewestSteps.path)}`
								: '—'}
						</li>
						<li>
							Least loss:{' '}
							{state?.chains.bestYield
								? `${pct(state.chains.bestYield.yield)} · ${pathText(state.chains.bestYield.path)}`
								: '—'}
						</li>
					</ul>
				</div>
			</section>

			<section className="card">
				<h2>What if a supplier drops out?</h2>
				<p className="muted small">
					<code>fork</code> today's graph, take the checked chemicals off the market in the branch,
					and re-plan. The baseline never sees the change.
				</p>
				<div className="cuts">
					{buyable.map((m) => (
						<label key={m.id} className={cut.includes(m.id) ? 'chip on' : 'chip'}>
							<input
								type="checkbox"
								checked={cut.includes(m.id)}
								onChange={(e) =>
									setCut((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))
								}
							/>
							{m.name}
						</label>
					))}
				</div>
				<button
					type="button"
					className="primary"
					onClick={fork}
					disabled={forking || cut.length === 0}
				>
					{forking ? 'Forking…' : `Fork without ${cut.map(nameOf).join(', ') || '…'}`}
				</button>
				{compare && (
					<div className="compare">
						{[
							{ label: 'Baseline, today', s: compare.base },
							{ label: `What-if: ${compare.label}`, s: compare.branch },
						].map(({ label, s }) => (
							<div key={label} className="mini">
								<h3>{label}</h3>
								{s.plan ? (
									<>
										<RouteBadges routes={s.plan.routes} colors={colors} />
										<Stats plan={s.plan} />
										<p className="muted small">{s.plan.steps.map((x) => x.id).join(' → ')}</p>
									</>
								) : (
									<p className="muted">No route to ibuprofen.</p>
								)}
							</div>
						))}
					</div>
				)}
			</section>

			<section className="card calls">
				<h2>The graphx calls behind this view</h2>
				<pre>
					<code>{`const at = ${state?.at ?? 'undefined /* live: today, incl. what-if writes */'}   // ${year >= meta.lastYear ? 'now' : `1 Jan ${year}`}

bulkLoad(db, schema, rows)            // catalog loaded with its own validFrom / validTo
g.listNodes({ asOf: at })             // molecules + reactions known then  → planner, canvas
g.listEdges({ asOf: at })             // reactant / product / catalyst edges
shortestPath(db, 'ibb', 'ibuprofen', { asOf: at, weighted: false })   // ${state?.chains.fewestSteps?.steps ?? '–'} steps
match(schema, db).node('m', 'molecule').where('m', 'severity', 'severe')
  .out('reactant').node('r', 'reaction').asOf(at)                     // ${state?.hazards.length ?? 0} hazard links
diff(db, previousEvent, lastEvent)    // what the last event added
history(db, '${selected ?? 'F2'}')                  // every version of a reaction
g.fork(branchDb) → branch.updateNode(id, { data: { price: null } })  // the what-if`}</code>
				</pre>
			</section>

			<footer className="muted small">
				Routes and dates from the Boots patent (1961), the BHC process (1992), Bogdan et al. 2009
				and Snead &amp; Jamison 2015; molecular weights are real, so atom economy is computed.
				Yields and prices are rounded, illustrative figures, good for ranking routes, not for
				costing a plant.
			</footer>
		</main>
	);
}
