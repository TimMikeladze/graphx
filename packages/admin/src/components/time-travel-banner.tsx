import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { fmtTime } from '@/lib/format';

/**
 * Shown whenever the explorer is pinned to a past instant — of the world (`asOf`), of what the
 * graph believed (`recordedAsOf`), or both. Editing is disabled there because a write applies to
 * the LIVE version, not the one on screen — so the banner says what is being viewed and offers
 * the way back.
 */
export function TimeTravelBanner({
	asOf,
	recordedAsOf,
	onReturn,
}: {
	asOf?: number;
	recordedAsOf?: number;
	onReturn: () => void;
}) {
	const what = [
		asOf !== undefined ? `the world at ${fmtTime(asOf)}` : undefined,
		recordedAsOf !== undefined ? `as recorded at ${fmtTime(recordedAsOf)}` : undefined,
	]
		.filter(Boolean)
		.join(', ');
	return (
		<div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
			<HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5 shrink-0" />
			<span>
				Viewing <span className="font-medium tabular-nums">{what}</span> — read-only, because an
				edit would apply to the live version rather than this one.
			</span>
			<Button
				variant="link"
				size="xs"
				className="ml-auto h-auto p-0 text-amber-700 dark:text-amber-400"
				onClick={onReturn}
			>
				Return to now
			</Button>
		</div>
	);
}
