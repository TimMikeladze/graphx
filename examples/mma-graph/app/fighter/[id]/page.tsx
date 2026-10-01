import { notFound } from 'next/navigation';
import { FighterLink, OutcomePill, TitlePill } from '@/components/pills';
import { RecordTimeTravel } from '@/components/record-time-travel';
import { getFighter, getFighterBio, getFighterFights } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

export default async function FighterPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const { graph } = await mma();
	const fighter = await getFighter(graph, id);
	if (!fighter) notFound();
	const [list, bio] = await Promise.all([getFighterFights(graph, id), getFighterBio(graph, id)]);
	if (!list) notFound();

	const d = (fighter.derived ?? {}) as Record<string, number>;
	const meta = [
		fighter.nationality,
		fighter.division,
		fighter.team,
		fighter.nickname ? `“${fighter.nickname}”` : null,
	]
		.filter(Boolean)
		.join(' · ');
	const dates = list.fights
		.map((f) => f.date)
		.filter(Boolean)
		.sort();
	const firstDate = dates[0] ?? '1993-11-12';

	return (
		<>
			<h1>
				{fighter.name}{' '}
				{fighter.stub ? (
					<span
						className="pill nc"
						title="No Wikipedia article — record derived from opponents' tables"
					>
						stub
					</span>
				) : null}
			</h1>
			<p className="sub">{meta || 'mixed martial artist'}</p>
			<div className="grid cols-2" style={{ marginTop: 18 }}>
				<div className="card">
					<h2 style={{ marginTop: 0 }}>Record — time travel</h2>
					<RecordTimeTravel id={id} firstDate={firstDate} />
				</div>
				<div className="card">
					<h2 style={{ marginTop: 0 }}>Career</h2>
					<div className="kv">
						<span className="k">Fights</span>
						<span className="mono">
							{d.wins ?? 0} W · {d.losses ?? 0} L · {d.draws ?? 0} D{d.nc ? ` · ${d.nc} NC` : ''}
						</span>
						<span className="k">Win rate</span>
						<span className="mono">
							{d.win_rate != null ? `${((d.win_rate as number) * 100).toFixed(1)}%` : '–'}
						</span>
						<span className="k">Wins by</span>
						<span>
							{d.ko_wins ?? 0} KO/TKO · {d.sub_wins ?? 0} sub · {d.dec_wins ?? 0} dec
							{d.other_wins ? ` · ${d.other_wins} other` : ''}
						</span>
						<span className="k">Losses by</span>
						<span>
							{d.ko_losses ?? 0} KO/TKO · {d.sub_losses ?? 0} sub · {d.dec_losses ?? 0} dec
						</span>
						<span className="k">Title fights</span>
						<span>
							{d.title_fights ?? 0} ({d.title_wins ?? 0} won, {d.title_defenses ?? 0} defenses)
						</span>
						<span className="k">Streak</span>
						<span>{d.streak_count ? `${d.streak_count} ${d.streak_type}` : '–'}</span>
						<span className="k">Active</span>
						<span className="mono">
							{d.active_from ?? '?'} → {d.active_to ?? '?'}
						</span>
						{fighter.birth_date ? (
							<>
								<span className="k">Born</span>
								<span className="mono">{String(fighter.birth_date)}</span>
							</>
						) : null}
						{fighter.height ? (
							<>
								<span className="k">Height</span>
								<span>{String(fighter.height)}</span>
							</>
						) : null}
						{fighter.reach ? (
							<>
								<span className="k">Reach</span>
								<span>{String(fighter.reach)}</span>
							</>
						) : null}
						{fighter.style ? (
							<>
								<span className="k">Style</span>
								<span>{String(fighter.style)}</span>
							</>
						) : null}
					</div>
				</div>
			</div>
			<h2>Fight history — {list.count} fights</h2>
			<div className="card" style={{ padding: '6px 4px' }}>
				<table>
					<thead>
						<tr>
							<th>Date</th>
							<th>Opponent</th>
							<th>Result</th>
							<th>Method</th>
							<th className="num">R</th>
							<th className="num">Time</th>
							<th>Event</th>
						</tr>
					</thead>
					<tbody>
						{list.fights.map((x) => (
							<tr key={x.id}>
								<td className="mono dim">{x.date ?? ''}</td>
								<td>
									<FighterLink id={x.opponent_id} name={x.opponent_name ?? x.opponent_id} />
								</td>
								<td>
									<OutcomePill outcome={x.outcome} />
								</td>
								<td>
									{x.method}
									<TitlePill title={x.title} />
								</td>
								<td className="num">{x.round ?? '–'}</td>
								<td className="num">{x.time ?? '–'}</td>
								<td className="muted">{x.event ?? ''}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{bio ? <p className="footnote">{bio}</p> : null}
		</>
	);
}
