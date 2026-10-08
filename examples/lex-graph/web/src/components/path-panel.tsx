import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { colorForType } from '@/lib/graph-style';
import { type Brief, type Scope, useDetail, usePath } from '~/atlas';
import { NodeRow, Section } from '~/components/node-row';
import { SearchBox } from '~/components/search-box';

/** A path endpoint, shown from its id (the URL holds ids, not names). */
function useBrief(id: string | undefined, scope: Scope): Brief | undefined {
	const { data } = useDetail(id, scope);
	if (!data) return undefined;
	// A detail's `guests` are rows; a row's are names. The picker only needs the row fields.
	const { id: nid, type, label, image, tagline, publishedAt, number } = data;
	return { id: nid, type, label, image, tagline, publishedAt, number };
}

const EXAMPLES: Array<[string, string]> = [
	['Carlo Rovelli', 'Elon Musk'],
	['Noam Chomsky', 'Joe Rogan'],
	['Wynton Marsalis', 'Khabib Nurmagomedov'],
	['Donald Knuth', 'MrBeast'],
];

/**
 * Degrees of separation. Pick two nodes; the server walks people, episodes, topics and hosts for
 * the shortest chain — across shows when they share a guest — and the canvas draws just that chain.
 */
export function PathPanel({
	from,
	to,
	scope,
	selected,
	onChange,
	onSelect,
	onExample,
}: {
	from?: string;
	to?: string;
	scope: Scope;
	selected?: string;
	onChange: (patch: { from?: string; to?: string }) => void;
	onSelect: (n: Brief) => void;
	onExample: (from: string, to: string) => void;
}) {
	const a = useBrief(from, scope);
	const b = useBrief(to, scope);
	const path = usePath(from, to, scope);
	const steps = path.data?.path;

	return (
		<div className="space-y-3 px-3 pt-3 pb-6">
			<p className="text-xs leading-relaxed text-muted-foreground">
				How is anyone connected to anyone else, on either show? The shortest chain through shared
				episodes, topics, on-air mentions and hosts.
			</p>
			<SearchBox
				placeholder="From…"
				scope={scope}
				value={from ? a : undefined}
				onPick={(n) => onChange({ from: n.id })}
				onClear={() => onChange({ from: undefined })}
			/>
			<SearchBox
				placeholder="To…"
				scope={scope}
				value={to ? b : undefined}
				onPick={(n) => onChange({ to: n.id })}
				onClear={() => onChange({ to: undefined })}
			/>
			{!(from && to) && (
				<Section title="Try">
					{EXAMPLES.map(([x, y]) => (
						<button
							key={`${x}-${y}`}
							type="button"
							onClick={() => onExample(x, y)}
							className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60"
						>
							{x} <HugeiconsIcon icon={ArrowRight01Icon} className="size-3 text-muted-foreground" />{' '}
							{y}
						</button>
					))}
				</Section>
			)}
			{from && to && path.isFetching && (
				<p className="text-xs text-muted-foreground">Walking the graph…</p>
			)}
			{from && to && path.data && !steps && (
				<p className="text-sm text-muted-foreground">Not connected at this date.</p>
			)}
			{steps && (
				<Section title={`${steps.length - 1} hops`}>
					<ol className="relative">
						{steps.map((s, i) => (
							<li key={s.id} className="relative">
								{i < steps.length - 1 && (
									<span
										className="absolute top-7 bottom-[-0.375rem] left-[0.6875rem] w-px"
										style={{
											background: `linear-gradient(${colorForType(s.type)}, ${colorForType(steps[i + 1].type)})`,
										}}
									/>
								)}
								<NodeRow node={s} active={s.id === selected} onClick={() => onSelect(s)} />
							</li>
						))}
					</ol>
				</Section>
			)}
		</div>
	);
}
