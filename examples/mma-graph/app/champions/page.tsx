import { ChampionsBoard } from '@/components/champions-board';
import { FighterLink } from '@/components/pills';
import { getChampions, getReigns } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

export default async function ChampionsPage() {
	const { graph } = await mma();
	const today = new Date().toISOString().slice(0, 10);
	const [champions, reigns] = await Promise.all([getChampions(graph, today), getReigns(graph)]);

	return (
		<>
			<h1>Champions</h1>
			<p className="sub">
				Reconstructed from every title fight in the graph. Move the date to see who held each belt
				at any moment.
			</p>
			<ChampionsBoard initial={champions} />
			<h2>Reign timeline</h2>
			<div className="card" style={{ padding: '6px 4px' }}>
				<table>
					<thead>
						<tr>
							<th>Title</th>
							<th>Champion</th>
							<th>Reign started</th>
						</tr>
					</thead>
					<tbody>
						{reigns.map((t) => (
							<tr key={`${t.title}:${t.since}`}>
								<td className="muted">{t.title}</td>
								<td>
									<FighterLink id={t.champion_id} name={t.champion_name ?? t.champion_id} />
								</td>
								<td className="mono dim">{t.since}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}
