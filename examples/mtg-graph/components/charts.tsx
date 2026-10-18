'use client';
// Keep TanStack Charts and its d3 dependencies behind this module.
import { useMemo } from 'react';
import { defineChart, barY } from '@tanstack/charts';
import { Chart } from '@tanstack/charts/react';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
export interface CurveRow {
	mv: string;
	count: number;
}
export function Curve({ rows }: { rows: CurveRow[] }) {
	const chart = useMemo(
		() =>
			defineChart({
				marks: [
					barY(rows, {
						x: (d: CurveRow) => d.mv,
						y: (d: CurveRow) => d.count,
						fill: '#171717',
						inset: 5,
					}),
				],
				scales: {
					x: { scale: scaleBand, axis: { label: 'Mana value' } },
					y: { scale: scaleLinear, nice: true, grid: true, axis: { label: 'Cards' } },
				},
				tooltip: {
					use: tooltip,
					format: (p) => `${(p.datum as CurveRow).mv} MV · ${(p.datum as CurveRow).count} cards`,
				},
			}),
		[rows],
	);
	return (
		<div className="curve-chart">
			<Chart definition={chart} height={225} ariaLabel="Mainboard nonland cards by mana value" />
		</div>
	);
}
