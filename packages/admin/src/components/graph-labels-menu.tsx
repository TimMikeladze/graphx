import { HugeiconsIcon } from '@hugeicons/react';
import { TextFontIcon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@/components/ui/popover';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { LabelSettings, LabelSource } from '@/lib/graph-style';

const SOURCES: Array<{ value: LabelSource; label: string; hint: string }> = [
	{ value: 'name', label: 'Name', hint: "the node's name or title" },
	{ value: 'type', label: 'Type', hint: 'person, document, …' },
	{ value: 'id', label: 'ID', hint: 'abbreviated identifier' },
	{ value: 'both', label: 'Name and type', hint: 'name · type' },
	{ value: 'off', label: 'Off', hint: 'no node captions' },
];

const LIMITS = [20, 40, 80, 150, 300];

/** Canvas label settings: what node captions say, how many, and whether edges are named. */
export function GraphLabelsMenu({
	settings,
	onChange,
	showLimit = true,
}: {
	settings: LabelSettings;
	onChange: (next: LabelSettings) => void;
	/** The caption budget only exists on the force canvas — flow cards always show their caption. */
	showLimit?: boolean;
}) {
	return (
		<Popover>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button variant="ghost" size="icon-sm" aria-label="Label settings">
							<HugeiconsIcon icon={TextFontIcon} strokeWidth={2} />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="left">Label settings</TooltipContent>
			</Tooltip>

			<PopoverContent side="left" align="start" className="w-64">
				<PopoverHeader>
					<PopoverTitle>Labels</PopoverTitle>
					<PopoverDescription>What the canvas writes next to each node.</PopoverDescription>
				</PopoverHeader>

				<div className="grid gap-3 p-3 pt-0">
					<div className="grid gap-1.5">
						<Label htmlFor="label-source">Node labels</Label>
						<Select
							value={settings.source}
							onValueChange={(source) => onChange({ ...settings, source: source as LabelSource })}
						>
							<SelectTrigger id="label-source" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{SOURCES.map((s) => (
									<SelectItem key={s.value} value={s.value}>
										{s.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							{SOURCES.find((s) => s.value === settings.source)?.hint}
						</p>
					</div>

					{showLimit && (
						<div className="grid gap-1.5">
							<Label htmlFor="label-limit">Labels shown</Label>
							<Select
								value={String(settings.limit)}
								onValueChange={(limit) => onChange({ ...settings, limit: Number(limit) })}
							>
								<SelectTrigger id="label-limit" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{LIMITS.map((n) => (
										<SelectItem key={n} value={String(n)}>
											{n} at a time
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								Highest-degree nodes first; more labels means a denser canvas.
							</p>
						</div>
					)}

					<div className="grid gap-1.5">
						<Label htmlFor="label-edges">Edge labels</Label>
						<Select
							value={settings.edges ? 'on' : 'off'}
							onValueChange={(v) => onChange({ ...settings, edges: v === 'on' })}
						>
							<SelectTrigger id="label-edges" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="off">Off</SelectItem>
								<SelectItem value="on">Show relationship names</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							Every edge on a small graph; on a dense one they are dropped rather than smeared.
						</p>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="label-images">Node images</Label>
						<Select
							value={settings.images ? 'on' : 'off'}
							onValueChange={(v) => onChange({ ...settings, images: v === 'on' })}
						>
							<SelectTrigger id="label-images" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="on">Show avatars</SelectItem>
								<SelectItem value="off">Off</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							For nodes whose data carries an image URL; the rest keep their type dot.
						</p>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
