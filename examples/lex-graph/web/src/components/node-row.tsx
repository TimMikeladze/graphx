import { colorForType } from '@/lib/graph-style';
import { cn } from '@/lib/utils';
import { type Brief, fmtDate } from '~/atlas';

/** The one line under a node's name: an episode's date and title, a person's tagline, a show's host. */
export function subtitleOf(n: Brief): string | undefined {
	if (n.type === 'episode') return [fmtDate(n.publishedAt), n.title].filter(Boolean).join(' · ');
	if (n.type === 'person' || n.type === 'podcast') return n.tagline;
	return n.type;
}

/**
 * A node in any list: thumbnail (episodes, people and shows), the canvas's own type color, label, and a
 * subtitle. Colors come from the admin's `colorForType`, so a row matches its dot on the canvas.
 */
export function NodeRow({
	node,
	onClick,
	active,
	trailing,
	subtitle,
	compact,
}: {
	node: Brief;
	onClick?: () => void;
	active?: boolean;
	trailing?: React.ReactNode;
	subtitle?: React.ReactNode;
	compact?: boolean;
}) {
	const sub = subtitle ?? subtitleOf(node);
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				'group flex w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-accent/60',
				compact ? 'py-1' : 'py-1.5',
				active && 'bg-accent',
			)}
		>
			{node.image && !compact ? (
				<img
					src={node.image}
					alt=""
					loading="lazy"
					className="h-9 w-16 shrink-0 rounded object-cover ring-1 ring-border"
				/>
			) : (
				<span
					className="ml-0.5 inline-block size-2 shrink-0 rounded-full"
					style={{ backgroundColor: colorForType(node.type) }}
				/>
			)}
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm text-foreground">{node.label}</span>
				{sub && !compact && (
					<span className="block truncate text-xs text-muted-foreground">{sub}</span>
				)}
			</span>
			{trailing && (
				<span className="shrink-0 text-xs text-muted-foreground tabular-nums">{trailing}</span>
			)}
		</button>
	);
}

/** A titled list section. */
export function Section({
	title,
	children,
	action,
}: {
	title: string;
	children: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<section className="space-y-1">
			<div className="flex items-center justify-between px-2 pt-3 pb-0.5">
				<h3 className="text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase">
					{title}
				</h3>
				{action}
			</div>
			{children}
		</section>
	);
}

/** A rounded chip for a topic, sponsor, show or person inline in text. */
export function Chip({ node, onClick }: { node: Brief; onClick?: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-accent"
		>
			<span
				className="inline-block size-1.5 rounded-full"
				style={{ backgroundColor: colorForType(node.type) }}
			/>
			{node.label}
		</button>
	);
}
