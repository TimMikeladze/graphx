import { FighterLink } from '@/components/pills';
import { getLeaderboard } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

export default async function FightersPage() {
	const { graph } = await mma();
	const board = await getLeaderboard(graph, 'wins', 50);

	return (
		<>
			<h1>Fighters</h1>
			<p className="sub">
				Search with the box top-right — full-text over names, teams, divisions and nationalities.
			</p>
			<h2>Top by wins</h2>
			<div className="card" style={{ padding: '6px 4px' }}>
				<table>
					<thead>
						<tr>
							<th></th>
							<th>Fighter</th>
							<th className="num">Wins</th>
							<th className="num">KO</th>
							<th className="num">Sub</th>
							<th className="num">Dec</th>
							<th className="num">Title W</th>
							<th className="num">Title def.</th>
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
								<td className="num">{r.derived.ko_wins ?? 0}</td>
								<td className="num">{r.derived.sub_wins ?? 0}</td>
								<td className="num">{r.derived.dec_wins ?? 0}</td>
								<td className="num">{r.derived.title_wins ?? 0}</td>
								<td className="num">{r.derived.title_defenses ?? 0}</td>
								<td className="dim mono">{r.record}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}
