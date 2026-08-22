import { HugeiconsIcon } from '@hugeicons/react';
import { Moon02Icon, Sun03Icon } from '@hugeicons/core-free-icons';
import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Light/dark toggle. (Also bound to the `d` key globally by the ThemeProvider.) */
export function ThemeToggle() {
	const { theme, setTheme } = useTheme();
	const dark = theme === 'dark';
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={() => setTheme(dark ? 'light' : 'dark')}
					aria-label="Toggle theme"
				>
					<HugeiconsIcon icon={dark ? Sun03Icon : Moon02Icon} strokeWidth={2} />
				</Button>
			</TooltipTrigger>
			<TooltipContent>Toggle theme (d)</TooltipContent>
		</Tooltip>
	);
}
