/**
 * Every chart in the app. This is the one module that imports TanStack Charts (it pulls in d3);
 * the rest of the app imports these components. Colours come from the `--ts-chart-*` tokens on
 * `.chart` in styles.css, so light and dark follow the page.
 */
import { barY, colorLegend, defineChart, stack } from '@tanstack/charts';
import { Chart } from '@tanstack/charts/react';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
import { useMemo } from 'react';
import type { Day, RouteDetail } from './api.ts';

type Hourly = RouteDetail['hourly'][number] & { series: string };

/** Departures per hour for one route and day, stacked by direction. */
export function HourlyChart({
	rows,
	day,
	headsigns,
}: {
	rows: RouteDetail['hourly'];
	day: Day;
	headsigns: [string, string];
}) {
	const definition = useMemo(() => {
		const data: Hourly[] = [];
		for (let h = 4; h < 27; h++)
			for (const dir of [0, 1]) {
				const r = rows.find((x) => x.day === day && x.hour === h && x.direction === dir);
				data.push({ day, hour: h, direction: dir, trips: r?.trips ?? 0, series: headsigns[dir]! });
			}
		return defineChart({
			marks: [
				barY(data, {
					x: (d: Hourly) => String(d.hour),
					y: (d: Hourly) => d.trips,
					color: (d: Hourly) => d.series,
					layout: stack({ order: [...headsigns] }),
				}),
			],
			scales: {
				x: {
					scale: () => scaleBand().padding(0.2),
					axis: { ticks: { format: (h: string) => (Number(h) % 3 === 0 ? `${h}:00` : '') } },
				},
				y: { scale: scaleLinear, nice: true, grid: true, axis: { label: 'trips / hour' } },
			},
			color: { legend: colorLegend({}) },
			tooltip: {
				use: tooltip,
				format: (p: { datum: Hourly }) =>
					`${p.datum.series} · ${p.datum.hour}:00 · ${p.datum.trips} trips`,
			},
		});
	}, [rows, day, headsigns]);
	return (
		<div className="chart">
			<Chart
				definition={definition}
				height={160}
				ariaLabel={`Trips per hour by direction on ${day}s`}
			/>
		</div>
	);
}
