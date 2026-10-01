import { OutcomePill, TitlePill } from '@/components/pills';
import { getFighter, getHead2Head } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

export default async function Head2HeadPage({
	searchParams,
}: {
	searchParams: Promise<{ a?: string; b?: string }>;
}) {
	const { a = '', b = '' } = await searchParams;
	const trimmedA = a.trim();
	const trimmedB = b.trim();

	let result: Awaited<ReturnType<typeof getHead2Head>> = null;
	let error: string | null = null;
	let nameA: string | null = null;
	if (trimmedA && trimmedB) {
		const { graph } = await mma();
		const fighterA = await getFighter(graph, trimmedA);
		result = await getHead2Head(graph, trimmedA, trimmedB);
		if (!result || !fighterA) error = 'fighter not found';
		else nameA = fighterA.name;
	}

	return (
		<>
			<h1>Head-to-head</h1>
			<p className="sub">Every meeting between two fighters, across every promotion.</p>
			<form className="h2hform" action="/h2h" method="get">
				<input
					type="text"
					name="a"
					placeholder="fighter id, e.g. frankie-edgar"
					defaultValue={trimmedA}
				/>
				<span className="dim">vs</span>
				<input
					type="text"
					name="b"
					placeholder="fighter id, e.g. gray-maynard"
					defaultValue={trimmedB}
				/>
				<button type="submit">Go</button>
			</form>
			{error ? (
				<div className="errbox">{error}</div>
			) : result && nameA ? (
				<>
					<div className="card" style={{ marginBottom: 14 }}>
						<div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>
							{nameA} leads {result.fights.filter((f) => f.outcome === 'win').length}–
							{result.fights.filter((f) => f.outcome === 'loss').length}
							{result.fights.some((f) => f.outcome !== 'win' && f.outcome !== 'loss')
								? ` (${result.fights.filter((f) => f.outcome !== 'win' && f.outcome !== 'loss').length} other)`
								: ''}{' '}
							— {result.met} meetings
						</div>
					</div>
					<div className="card" style={{ padding: '6px 4px' }}>
						<table>
							<thead>
								<tr>
									<th>Date</th>
									<th>Result for {nameA}</th>
									<th>Method</th>
									<th className="num">R</th>
									<th className="num">Time</th>
									<th>Event</th>
								</tr>
							</thead>
							<tbody>
								{result.fights.map((f) => (
									<tr key={f.id}>
										<td className="mono dim">{f.date ?? ''}</td>
										<td>
											<OutcomePill outcome={f.outcome} />
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
					</div>
				</>
			) : null}
		</>
	);
}
