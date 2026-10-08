/**
 * Every chart in the app. This is the one module that imports TanStack Charts (it pulls in d3);
 * the rest of the app imports these components. Colours come from the `--ts-chart-*` palette
 * tokens set on `.chart` in styles.css, so light and dark follow the page.
 */
import { barX, barY, colorLegend, defineChart, lineY, ruleX, stack } from '@tanstack/charts';
import { Chart } from '@tanstack/charts/react';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
import { useMemo } from 'react';
import { type DayRow, fmt, type IntersectionDetail, minutes } from './api.ts';

const hourTicks = (v: number) => (v % 180 === 0 ? minutes(v) : '');

/** How much slower than free flow the average vehicle-second is, over the day. */
interface DayPoint {
	start: number;
	slowdown: number;
	series: string;
}
export function DayChart({
	base,
	scenario,
	now,
}: {
	base: DayRow[];
	scenario?: DayRow[];
	now: number;
}) {
	const definition = useMemo(() => {
		const rows: DayPoint[] = [
			...base.map((r) => ({
				start: r.start + r.minutes / 2,
				slowdown: r.slowdown,
				series: 'Baseline',
			})),
			...(scenario ?? []).map((r) => ({
				start: r.start + r.minutes / 2,
				slowdown: r.slowdown,
				series: 'Scenario',
			})),
		];
		return defineChart({
			marks: [
				ruleX([now], { x: (d: number) => d, strokeOpacity: 0.35, strokeDasharray: '3 3' }),
				lineY(rows, {
					x: (d: DayPoint) => d.start,
					y: (d: DayPoint) => d.slowdown,
					color: (d: DayPoint) => d.series,
					strokeWidth: 2,
				}),
			],
			scales: {
				x: {
					scale: scaleLinear,
					domain: [0, 1440],
					axis: {
						ticks: { values: [0, 180, 360, 540, 720, 900, 1080, 1260, 1440], format: hourTicks },
					},
				},
				y: {
					scale: scaleLinear,
					nice: true,
					grid: true,
					axis: { label: '× free-flow time', ticks: { format: (v: number) => `${v.toFixed(1)}×` } },
				},
			},
			...(scenario ? { color: { legend: colorLegend({}) } } : {}),
			tooltip: {
				use: tooltip,
				format: (p: { datum: DayPoint }) =>
					`${p.datum.series} · ${minutes(Math.floor(p.datum.start))} · ${p.datum.slowdown.toFixed(2)}× free flow`,
			},
		});
	}, [base, scenario, now]);
	return (
		<div className="chart">
			<Chart
				definition={definition}
				height={170}
				ariaLabel="City-wide slowdown versus free-flow time across the modelled day"
			/>
		</div>
	);
}

/** One measure for an intersection over the day — delay or volume, never both on one axis. */
interface WindowPoint {
	start: number;
	value: number;
}
export function WindowChart({
	rows,
	measure,
	now,
}: {
	rows: IntersectionDetail['byWindow'];
	measure: 'delaySec' | 'volume';
	now: number;
}) {
	const definition = useMemo(() => {
		const data: WindowPoint[] = rows.map((r) => ({ start: r.start, value: r[measure] }));
		return defineChart({
			marks: [
				ruleX([now], { x: (d: number) => d, strokeOpacity: 0.35, strokeDasharray: '3 3' }),
				lineY(data, {
					x: (d: WindowPoint) => d.start,
					y: (d: WindowPoint) => d.value,
					strokeWidth: 2,
				}),
			],
			scales: {
				x: {
					scale: scaleLinear,
					domain: [0, 1440],
					axis: { ticks: { values: [0, 360, 720, 1080, 1440], format: hourTicks } },
				},
				y: {
					scale: scaleLinear,
					nice: true,
					grid: true,
					axis: { label: measure === 'volume' ? 'vehicles / h' : 'delay (s)' },
				},
			},
			tooltip: {
				use: tooltip,
				format: (p: { datum: WindowPoint }) =>
					`${minutes(p.datum.start)} · ${fmt.format(p.datum.value)} ${measure === 'volume' ? 'vehicles/h entering' : 's average delay'}`,
			},
		});
	}, [rows, measure, now]);
	return (
		<div className="chart">
			<Chart
				definition={definition}
				height={120}
				ariaLabel={
					measure === 'volume'
						? 'Vehicles per hour entering this intersection across the day'
						: 'Average delay at this intersection across the day'
				}
			/>
		</div>
	);
}

/** A ranked horizontal bar list: label → value. */
interface BarRow {
	label: string;
	value: number;
}
export function Bars({
	rows,
	unit,
	ariaLabel,
	signed = false,
}: {
	rows: BarRow[];
	unit: string;
	ariaLabel: string;
	signed?: boolean;
}) {
	const definition = useMemo(
		() =>
			defineChart({
				marks: [
					barX(rows, {
						y: (d: BarRow) => d.label,
						x: (d: BarRow) => d.value,
						fill: signed ? (d: BarRow) => (d.value < 0 ? 'var(--good)' : 'var(--bad)') : undefined,
						radius: 4,
					}),
				],
				scales: {
					y: {
						scale: () => scaleBand().padding(0.25),
						axis: { ticks: { format: (v: string) => (v.length > 26 ? `${v.slice(0, 25)}…` : v) } },
					},
					x: { scale: scaleLinear, nice: true, grid: true, axis: { label: unit } },
				},
				tooltip: {
					use: tooltip,
					format: (p: { datum: BarRow }) =>
						`${p.datum.label}: ${fmt.format(p.datum.value)} ${unit}`,
				},
			}),
		[rows, unit, signed],
	);
	return (
		<div className="chart">
			<Chart
				definition={definition}
				height={Math.max(90, rows.length * 22 + 40)}
				ariaLabel={ariaLabel}
			/>
		</div>
	);
}

/** Crashes per year, stacked by who was hurt. */
interface CrashYear {
	year: string;
	mode: string;
	count: number;
}
export function CrashYears({ rows, ariaLabel }: { rows: CrashYear[]; ariaLabel: string }) {
	const definition = useMemo(
		() =>
			defineChart({
				marks: [
					barY(rows, {
						x: (d: CrashYear) => d.year,
						y: (d: CrashYear) => d.count,
						color: (d: CrashYear) => d.mode,
						layout: stack({ order: ['Vehicle', 'Cyclist', 'Pedestrian'] }),
					}),
				],
				scales: {
					x: { scale: () => scaleBand().padding(0.2) },
					y: { scale: scaleLinear, nice: true, grid: true, axis: { label: 'crashes' } },
				},
				color: { legend: colorLegend({}) },
				tooltip: {
					use: tooltip,
					format: (p: { datum: CrashYear }) =>
						`${p.datum.year} · ${p.datum.mode}: ${p.datum.count}`,
				},
			}),
		[rows],
	);
	return (
		<div className="chart">
			<Chart definition={definition} height={170} ariaLabel={ariaLabel} />
		</div>
	);
}

/** Trip time by departure time for one route. */
interface TripPoint {
	start: number;
	minutes: number;
}
export function TripChart({ rows, now }: { rows: TripPoint[]; now: number }) {
	const definition = useMemo(
		() =>
			defineChart({
				marks: [
					ruleX([now], { x: (d: number) => d, strokeOpacity: 0.35, strokeDasharray: '3 3' }),
					lineY(rows, {
						x: (d: TripPoint) => d.start,
						y: (d: TripPoint) => d.minutes,
						strokeWidth: 2,
						points: true,
					}),
				],
				scales: {
					x: {
						scale: scaleLinear,
						domain: [0, 1440],
						axis: { ticks: { values: [0, 360, 720, 1080, 1440], format: hourTicks } },
					},
					y: {
						scale: scaleLinear,
						nice: true,
						grid: true,
						axis: { label: 'minutes' },
						domain: [0, Math.max(5, ...rows.map((r) => r.minutes)) * 1.1],
					},
				},
				tooltip: {
					use: tooltip,
					format: (p: { datum: TripPoint }) =>
						`Leave ${minutes(p.datum.start)} · ${p.datum.minutes.toFixed(1)} min`,
				},
			}),
		[rows, now],
	);
	return (
		<div className="chart">
			<Chart
				definition={definition}
				height={150}
				ariaLabel="Driving time for this route by departure time"
			/>
		</div>
	);
}
