import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon } from '@hugeicons/core-free-icons';

/** Shown when the server capped the graph slice (§19.2) — prompts the user to narrow filters. */
export function ResultsBanner() {
	return (
		<div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
			<HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5 shrink-0" />
			Results capped by the server row limit — narrow the filters for a complete view.
		</div>
	);
}
