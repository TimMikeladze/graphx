/**
 * Every TanStack Charts import lives in this module (it pulls in d3) — the rest of the app imports
 * these components, never the library.
 */
import { defineChart, lineY, ruleX } from '@tanstack/charts';
import { colorLegend } from '@tanstack/charts/legend';
import { Chart } from '@tanstack/charts/react';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
import { useMemo } from 'react';
import type { TimelineRow } from './api.ts';

interface Props {
	rows: TimelineRow[];
	year: number;
	ink: string;
	onPick: (year: number) => void;
}

const yearAxis = {
	scale: scaleLinear,
	axis: { label: 'Year', ticks: { format: (v: number) => String(v) } },
};

/** Longest linear sequence of the best route, by year. */
export function StepsChart({ rows, year, ink, onPick }: Props) {
	const definition = useMemo(
		() =>
			defineChart({
				marks: [
					lineY(rows, {
						x: (d: TimelineRow) => d.year,
						y: (d: TimelineRow) => d.steps,
						stroke: ink,
						strokeWidth: 2,
					}),
					ruleX([year], { strokeOpacity: 0.5, strokeDasharray: '3 3' }),
				],
				scales: {
					x: yearAxis,
					y: { scale: scaleLinear, nice: true, grid: true, axis: { label: 'Steps' } },
				},
				tooltip: {
					use: tooltip,
					format: (p) => `${p.datum.year} · ${p.datum.steps} steps · ${p.datum.route}`,
				},
			}),
		[rows, year, ink],
	);
	return (
		<Chart
			definition={definition}
			height={200}
			ariaLabel="Steps in the best route to ibuprofen, by year"
			onSelect={(p) => p && onPick(p.datum.year)}
		/>
	);
}

/** $ per mol of ibuprofen through the best route, by year. */
export function CostChart({ rows, year, ink, onPick }: Props) {
	const definition = useMemo(
		() =>
			defineChart({
				marks: [
					lineY(rows, {
						x: (d: TimelineRow) => d.year,
						y: (d: TimelineRow) => d.cost,
						stroke: ink,
						strokeWidth: 2,
					}),
					ruleX([year], { strokeOpacity: 0.5, strokeDasharray: '3 3' }),
				],
				scales: {
					x: yearAxis,
					y: { scale: scaleLinear, nice: true, grid: true, axis: { label: '$ / mol' } },
				},
				tooltip: {
					use: tooltip,
					format: (p) => `${p.datum.year} · $${p.datum.cost?.toFixed(0)}/mol · ${p.datum.route}`,
				},
			}),
		[rows, year, ink],
	);
	return (
		<Chart
			definition={definition}
			height={200}
			ariaLabel="Material cost per mol of ibuprofen through the best route, by year"
			onSelect={(p) => p && onPick(p.datum.year)}
		/>
	);
}

interface PctRow {
	year: number;
	value: number | null;
	metric: string;
	route: string | null;
}

/** Overall yield and atom economy — both percentages, so one axis is honest. */
export function EfficiencyChart({
	rows,
	year,
	colors,
	onPick,
}: Omit<Props, 'ink'> & { colors: [string, string] }) {
	const definition = useMemo(() => {
		const data: PctRow[] = rows.flatMap((r) => [
			{ year: r.year, value: r.yield, metric: 'Overall yield', route: r.route },
			{ year: r.year, value: r.atomEconomy, metric: 'Atom economy', route: r.route },
		]);
		return defineChart({
			marks: [
				lineY(data, {
					x: (d: PctRow) => d.year,
					y: (d: PctRow) => d.value,
					z: (d: PctRow) => d.metric,
					color: (d: PctRow) => d.metric,
					strokeWidth: 2,
				}),
				ruleX([year], { strokeOpacity: 0.5, strokeDasharray: '3 3' }),
			],
			scales: {
				x: yearAxis,
				y: { scale: scaleLinear, nice: true, grid: true, axis: { label: '%' } },
			},
			color: {
				domain: ['Overall yield', 'Atom economy'],
				range: colors,
				legend: colorLegend({ label: 'Metric' }),
			},
			focus: 'group-x',
			tooltip: { use: tooltip, format: (p) => `${p.datum.metric} ${p.datum.value?.toFixed(0)}%` },
		});
	}, [rows, year, colors]);
	return (
		<Chart
			definition={definition}
			height={200}
			ariaLabel="Overall yield and atom economy of the best route to ibuprofen, by year"
			onSelect={(p) => p && onPick(p.datum.year)}
		/>
	);
}
