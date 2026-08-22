import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Copy-to-clipboard icon button: swaps to a check for a moment and toasts. */
export function CopyButton({
	value,
	label = 'Copy',
	size = 'icon-xs',
	className,
}: {
	value: string;
	label?: string;
	size?: 'icon-xs' | 'icon-sm' | 'icon';
	className?: string;
}) {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard?.writeText(value);
			setCopied(true);
			toast.success(`${label.replace(/^Copy ?/, 'Copied ') || 'Copied'}`);
			setTimeout(() => setCopied(false), 1200);
		} catch {
			toast.error('Copy failed');
		}
	};

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size={size}
					className={cn('text-muted-foreground', className)}
					onClick={(e) => {
						e.stopPropagation();
						void copy();
					}}
					aria-label={label}
				>
					<HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
