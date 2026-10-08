import { Skeleton } from '@/components/ui/skeleton';
import { type Brief, fmtDate, type Scope, useOverview } from '~/atlas';
import { Chip, NodeRow, Section } from '~/components/node-row';

/**
 * The left panel when nothing is being traced: the shows at a glance, as of the scrubber's instant
 * and narrowed to the show filter. Every list is computed from the graph at that date, so dragging
 * back to 2019 shrinks it.
 */
export function OverviewPanel({
	scope,
	selected,
	onSelect,
}: {
	scope: Scope;
	selected?: string;
	onSelect: (n: Brief) => void;
}) {
	const { data } = useOverview(scope);

	if (!data) {
		return (
			<div className="space-y-2 p-3">
				{Array.from({ length: 8 }, (_, i) => (
					<Skeleton key={i} className="h-10 w-full" />
				))}
			</div>
		);
	}
	const row = (n: Brief, trailing?: React.ReactNode) => (
		<NodeRow
			key={n.id}
			node={n}
			active={n.id === selected}
			onClick={() => onSelect(n)}
			trailing={trailing}
		/>
	);
	return (
		<div className="px-1 pb-6">
			<dl className="grid grid-cols-4 gap-1 px-2 pt-3">
				{(
					[
						['episodes', data.counts.episodes],
						['people', data.counts.people],
						['topics', data.counts.topics],
						['sponsors', data.counts.sponsors],
					] as const
				).map(([k, v]) => (
					<div key={k} className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
						<dd className="text-base font-semibold text-foreground tabular-nums">
							{v.toLocaleString()}
						</dd>
						<dt className="text-[0.6875rem] text-muted-foreground">{k}</dt>
					</div>
				))}
			</dl>
			{data.podcasts.length > 1 && (
				<Section title="Shows">{data.podcasts.map((n) => row(n, `${n.count} eps`))}</Section>
			)}
			{data.latest.length > 0 && (
				<Section title="Latest">{data.latest.slice(0, 6).map((n) => row(n))}</Section>
			)}
			{data.crossovers.length > 0 && (
				<Section title={`On more than one show · ${data.crossovers.length}`}>
					{data.crossovers.slice(0, 10).map((n) => row(n, n.shows.join(' · ')))}
				</Section>
			)}
			{/* "Came back" means twice: a list of one-time guests ranked ×1 says nothing. */}
			{data.regulars.some((n) => (n.count ?? 0) > 1) && (
				<Section title="Came back most">
					{data.regulars
						.filter((n) => (n.count ?? 0) > 1)
						.slice(0, 8)
						.map((n) => row(n, `×${n.count}`))}
				</Section>
			)}
			{data.mentioned.length > 0 && (
				<Section title="Brought up most in other episodes">
					{data.mentioned.slice(0, 8).map((n) => row(n, n.count))}
				</Section>
			)}
			{data.topics.length > 0 && (
				<Section title="Topics in the most titles">
					<div className="flex flex-wrap gap-1.5 px-2 pt-1">
						{data.topics.map((t) => (
							<Chip
								key={t.id}
								node={{ ...t, label: `${t.label} · ${t.count}` }}
								onClick={() => onSelect(t)}
							/>
						))}
					</div>
				</Section>
			)}
			{data.sponsors.length > 0 && (
				<Section title="Longest-running sponsors">
					{data.sponsors.slice(0, 6).map((n) => row(n, `${n.count} eps`))}
				</Section>
			)}
			{data.latest[0] && (
				<p className="px-2 pt-4 text-[0.6875rem] text-muted-foreground">
					Newest in view: {fmtDate(data.latest[0].publishedAt)}
				</p>
			)}
		</div>
	);
}
