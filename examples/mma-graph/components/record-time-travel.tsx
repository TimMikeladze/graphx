'use client';

import { useEffect, useState } from 'react';
import type { RecordResult } from '@/src/server/queries';

function fmtRecord(r: RecordResult['record']): string {
	return `${r.wins}–${r.losses}–${r.draws}${r.nc ? ` (${r.nc} NC)` : ''}`;
}

/**
 * The record card's time travel: pick a date, see the fighter's record as it stood then
 * (`GET /api/record?id=&asOf=` — the fight graph filtered to that day).
 */
export function RecordTimeTravel({ id, firstDate }: { id: string; firstDate: string }) {
	const today = new Date().toISOString().slice(0, 10);
	const [asOf, setAsOf] = useState('');
	const [record, setRecord] = useState<RecordResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(
					`/api/record?id=${encodeURIComponent(id)}${asOf ? `&asOf=${asOf}` : ''}`,
				);
				if (!res.ok)
					throw new Error((await res.json().catch(() => ({}))).error ?? `http ${res.status}`);
				const body = (await res.json()) as RecordResult;
				if (!cancelled) {
					setRecord(body);
					setError(null);
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [id, asOf]);

	return (
		<>
			<div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
				<input
					type="date"
					value={asOf}
					min={firstDate}
					max={today}
					aria-label="record as of this date"
					onChange={(e) => setAsOf(e.target.value)}
				/>
				<button type="button" className="linklike hint" onClick={() => setAsOf('')}>
					today
				</button>
			</div>
			<div style={{ marginTop: 14 }}>
				{error ? (
					<div className="errbox">{error}</div>
				) : !record ? (
					<div className="skeleton" style={{ padding: 20 }}>
						loading…
					</div>
				) : (
					<RecordView record={record} label={asOf || 'today'} />
				)}
			</div>
		</>
	);
}

function RecordView({ record, label }: { record: RecordResult; label: string }) {
	const r = record.record;
	const decided = r.wins + r.losses || 1;
	return (
		<>
			<div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>
				{fmtRecord(r)}
			</div>
			<div className="hint">
				as it stood on {label} · {record.fights_considered} fights
			</div>
			<div className="bar">
				<i className="w" style={{ width: `${(r.wins / decided) * 100}%` }} />
				<i className="l" style={{ width: `${(r.losses / decided) * 100}%` }} />
				<i className="d" style={{ width: `${(r.draws / decided) * 100}%` }} />
				<i className="n" style={{ width: `${(r.nc / decided) * 100}%` }} />
			</div>
			<div className="hint">
				{r.ko_wins} KO · {r.sub_wins} sub · {r.dec_wins} dec · {r.title_wins} title wins
			</div>
		</>
	);
}
