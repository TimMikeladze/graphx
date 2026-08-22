import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { cn } from '@/lib/utils';

type IconSvg = IconSvgElement;

/**
 * A centered empty / error / hint state: optional icon, a title, and a muted sub-line. One
 * component for "no results", "failed to load", and "nothing selected" so they read consistently.
 */
export function EmptyState({
	icon,
	title,
	hint,
	tone = 'muted',
	action,
	className,
}: {
	icon?: IconSvg;
	title: string;
	hint?: React.ReactNode;
	tone?: 'muted' | 'destructive';
	action?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				'flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center',
				className,
			)}
		>
			{icon && (
				<div
					className={cn(
						'flex size-9 items-center justify-center rounded-full',
						tone === 'destructive'
							? 'bg-destructive/10 text-destructive'
							: 'bg-muted text-muted-foreground',
					)}
				>
					<HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-4.5" />
				</div>
			)}
			<p
				className={cn(
					'text-sm font-medium',
					tone === 'destructive' ? 'text-destructive' : 'text-foreground',
				)}
			>
				{title}
			</p>
			{hint && <p className="max-w-xs text-xs text-muted-foreground">{hint}</p>}
			{action && <div className="mt-1">{action}</div>}
		</div>
	);
}
