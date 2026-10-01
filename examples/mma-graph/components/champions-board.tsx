'use client';

import { useEffect, useState } from 'react';
import { FighterLink } from '@/components/pills';
import type { ChampionView } from '@/src/server/queries';

/**
 * The champions grid's time travel: who held each belt on the picked date
 * (`GET /api/champions?asOf=`). `initial` is today's grid, server-rendered.
 */
export function ChampionsBoard({ initial }: { initial: ChampionView[] }) {
	const today = new Date().toISOString().slice(0, 10);
	const [asOf, setAsOf] = useState(today);
	const [champions, setChampions] = useState<ChampionView[] | null>(initial);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`/api/champions?asOf=${encodeURIComponent(asOf)}`);
				if (!res.ok)
					throw new Error((await res.json().catch(() => ({}))).error ?? `http ${res.status}`);
				const body = (await res.json()) as { champions: ChampionView[] };
				if (!cancelled) {
					setChampions(body.champions);
					setError(null);
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [asOf]);

	return (
		<>
			<div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '16px 0' }}>
				<input
					type="date"
					value={asOf}
					min="1993-11-12"
					max={today}
					aria-label="champions as of this date"
					onChange={(e) => setAsOf(e.target.value)}
				/>
				<span className="hint">
					vacancies are invisible to fight data — a belt shows its last winner until the next title
					fight
				</span>
			</div>
			{error ? (
				<div className="errbox">{error}</div>
			) : (
				<div className="champgrid">
					{champions && champions.length > 0 ? (
						champions.map((c) => (
							<div className="card champ" key={`${c.title}:${c.since}`}>
								<div className="belt">
									<span className="belt-icon">🏆</span>
									{c.title}
								</div>
								<div className="who">
									<FighterLink id={c.champion_id} name={c.champion_name ?? c.champion_id} />
								</div>
								<div className="since">since {c.since}</div>
							</div>
						))
					) : (
						<div className="skeleton">no title fights before this date</div>
					)}
				</div>
			)}
		</>
	);
}
