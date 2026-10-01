import Link from 'next/link';
import { FighterLink } from '@/components/pills';
import { getLeaderboard, LEADERBOARD_METRICS } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

const METRIC_LABELS: Record<string, string> = {
	wins: 'wins',
	ko_wins: 'knockouts',
	sub_wins: 'submissions',
	dec_wins: 'decisions',
	title_wins: 'title wins',
	title_defenses: 'title defenses',
	losses: 'losses',
	streak_count: 'current streak',
};

export default async function LeadersPage({
	searchParams,
}: {
	searchParams: Promise<{ metric?: string }>;
}) {
	const { metric = 'wins' } = await searchParams;
	const { graph } = await mma();
	// Unknown metrics fall back to `wins` — pills only emit known ones.
	const safe = (LEADERBOARD_METRICS as readonly string[]).includes(metric) ? metric : 'wins';
	const board = await getLeaderboard(graph, safe, 100);

	return (
		<>
			<h1>Leaderboards</h1>
			<div className="metricpills">
				{Object.entries(METRIC_LABELS).map(([value, label]) => (
					<Link
						key={value}
						href={`/leaders?metric=${value}`}
						className={value === safe ? 'on' : undefined}
					>
						{label}
					</Link>
				))}
			</div>
			<div className="card" style={{ padding: '6px 4px' }}>
				<table>
					<thead>
						<tr>
							<th></th>
							<th>Fighter</th>
							<th className="num">{safe}</th>
							<th>Record</th>
						</tr>
					</thead>
					<tbody>
						{board.top.map((r, i) => (
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
			</div>
		</>
	);
}
