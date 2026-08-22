import { HugeiconsIcon } from '@hugeicons/react';
import {
	ChartRelationshipIcon,
	Flowchart01Icon,
	MoleculesIcon,
	NodeAddIcon,
	PauseIcon,
	PlayIcon,
	SquareArrowExpand01Icon,
	Target02Icon,
	ZoomInAreaIcon,
	ZoomOutAreaIcon,
} from '@hugeicons/core-free-icons';
import { GraphLabelsMenu } from '@/components/graph-labels-menu';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { LabelSettings } from '@/lib/graph-style';
import type { FlowLayout, Renderer } from '@/lib/types';
import type { IconSvgElement } from '@hugeicons/react';

function ToolButton({
	icon,
	label,
	onClick,
	disabled,
}: {
	icon: IconSvgElement;
	label: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={onClick}
					aria-label={label}
					disabled={disabled}
				>
					<HugeiconsIcon icon={icon} strokeWidth={2} />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="left">{label}</TooltipContent>
		</Tooltip>
	);
}

/** Floating canvas controls: renderer, fit, zoom, labels, layout/pause, fullscreen. */
export function GraphToolbar({
	renderer,
	onRendererChange,
	flowLayout,
	onFlowLayoutChange,
	paused,
	pausePinned,
	labels,
	onLabelsChange,
	onFit,
	onZoomIn,
	onZoomOut,
	onTogglePause,
	onToggleFullscreen,
	onCreateNode,
}: {
	renderer: Renderer;
	onRendererChange: (renderer: Renderer) => void;
	flowLayout: FlowLayout;
	onFlowLayoutChange: (layout: FlowLayout) => void;
	/**
	 * Cosmograph's effective simulation state (the toolbar's own pause OR'd with playback's pin —
	 * the caller merges these only for display, never for a state transition to react to).
	 */
	paused: boolean;
	/** Playback owns the simulation for its duration, so the pause control is inert while true. */
	pausePinned?: boolean;
	labels: LabelSettings;
	onLabelsChange: (next: LabelSettings) => void;
	onFit: () => void;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onTogglePause: () => void;
	onToggleFullscreen: () => void;
	/** Opens the node editor. Absent when the explorer is read-only. */
	onCreateNode?: () => void;
}) {
	const isCosmograph = renderer === 'cosmograph';

	return (
		<div className="hud absolute top-3 right-3 flex flex-col gap-0.5 p-1">
			{onCreateNode && (
				<>
					<ToolButton icon={NodeAddIcon} label="New node" onClick={onCreateNode} />
					<Separator className="my-0.5" />
				</>
			)}
			<ToolButton
				icon={isCosmograph ? Flowchart01Icon : ChartRelationshipIcon}
				label={isCosmograph ? 'Switch to flow renderer' : 'Switch to force canvas'}
				onClick={() => onRendererChange(isCosmograph ? 'flow' : 'cosmograph')}
			/>
			<Separator className="my-0.5" />
			<ToolButton icon={Target02Icon} label="Fit to view" onClick={onFit} />
			<ToolButton icon={ZoomInAreaIcon} label="Zoom in" onClick={onZoomIn} />
			<ToolButton icon={ZoomOutAreaIcon} label="Zoom out" onClick={onZoomOut} />
			<Separator className="my-0.5" />
			{/* The label budget rations Cosmograph's floating captions; flow cards always carry theirs. */}
			<GraphLabelsMenu settings={labels} onChange={onLabelsChange} showLimit={isCosmograph} />
			<Separator className="my-0.5" />
			{isCosmograph ? (
				<ToolButton
					icon={paused ? PlayIcon : PauseIcon}
					label={paused ? 'Resume layout' : 'Pause layout'}
					onClick={onTogglePause}
					disabled={pausePinned}
				/>
			) : (
				<ToolButton
					icon={flowLayout === 'layered' ? MoleculesIcon : Flowchart01Icon}
					label={flowLayout === 'layered' ? 'Organic layout' : 'Layered layout'}
					onClick={() => onFlowLayoutChange(flowLayout === 'layered' ? 'organic' : 'layered')}
				/>
			)}
			<ToolButton
				icon={SquareArrowExpand01Icon}
				label="Toggle fullscreen"
				onClick={onToggleFullscreen}
			/>
		</div>
	);
}
