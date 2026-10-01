import { FighterLink, TitlePill } from '@/components/pills';
import {
	getLeaderboard,
	getStats,
	type LeaderboardRow,
	type RecentFight,
} from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

function fmtDate(date: string): string {
	return new Date(`${date}T00:00:00Z`).toLocaleDateString('en', {
		timeZone: 'UTC',
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

function tableRecent(fights: RecentFight[]) {
	return (
		<table>
			<thead>
				<tr>
					<th>Date</th>
					<th>Winner</th>
					<th></th>
					<th>Loser</th>
					<th>Method</th>
					<th className="num">R</th>
					<th className="num">Time</th>
					<th>Event</th>
				</tr>
			</thead>
			<tbody>
				{fights.map((f) => (
					<tr key={f.id}>
						<td className="mono dim">{f.date}</td>
						<td>
							<FighterLink id={f.winner_id} name={f.winner_name} />
						</td>
						<td className="dim">def.</td>
						<td>
							{f.loser_id ? (
								<FighterLink id={f.loser_id} name={f.loser_name} />
							) : (
								<span className="muted">{f.loser_name ?? ''}</span>
							)}
						</td>
						<td>
							{f.method}
							<TitlePill title={f.title} />
						</td>
						<td className="num">{f.round ?? '–'}</td>
						<td className="num">{f.time ?? '–'}</td>
						<td className="muted">{f.event ?? ''}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function miniBoard(rows: LeaderboardRow[]) {
	return (
		<table>
			<tbody>
				{rows.map((r, i) => (
					<tr className="leaderrow" key={r.id}>
						<td>{i + 1}</td>
						<td>
							<FighterLink id={r.id} name={r.name} />
						</td>
						<td className="num">{r.value}</td>
						<td className="dim mono">{r.record}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

export default async function HomePage() {
	const { graph } = await mma();
	const stats = await getStats(graph, 10);
	const wins = await getLeaderboard(graph, 'wins', 5);
	const kos = await getLeaderboard(graph, 'ko_wins', 5);
	const latest = stats.recent[0]?.date;

	return (
		<>
			<h1>MMA, across time</h1>
			<p className="sub">
				Every fighter with a Wikipedia record — every fight, every promotion, one temporal graph.
				Move the date on any fighter or champion page to see the sport as it stood then.
			</p>
			<div className="grid cols-4" style={{ marginTop: 18 }}>
				<div className="card stat">
					<div className="n">{stats.fighters.toLocaleString('en')}</div>
					<div className="l">fighters</div>
				</div>
				<div className="card stat">
					<div className="n">{wins.count.toLocaleString('en')}</div>
					<div className="l">with derived records</div>
				</div>
				<div className="card stat">
					<div className="n">{stats.events.toLocaleString('en')}</div>
					<div className="l">events</div>
				</div>
				<div className="card stat">
					<div className="n">{latest ? fmtDate(latest) : '–'}</div>
					<div className="l">latest fight in the graph</div>
				</div>
			</div>
			<h2>Latest results</h2>
			<div className="card" style={{ padding: '6px 4px' }}>
				{tableRecent(stats.recent)}
			</div>
			<div className="grid cols-2" style={{ marginTop: 14 }}>
				<div>
					<h2>Most wins</h2>
					<div className="card">{miniBoard(wins.top)}</div>
				</div>
				<div>
					<h2>Most knockouts</h2>
					<div className="card">{miniBoard(kos.top)}</div>
				</div>
			</div>
			<p className="footnote">
				Served by Next.js server components reading the graphx graph in-process · graphx-generated
				API at <a href="/openapi.json">/openapi.json</a> and <a href="/docs">/docs</a>
			</p>
		</>
	);
}
