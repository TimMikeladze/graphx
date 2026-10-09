import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
	NextIcon,
	PauseIcon,
	PlayIcon,
	PreviousIcon,
	ZoomInAreaIcon,
	ZoomOutAreaIcon,
} from '@hugeicons/core-free-icons';
import { TimelineTrack } from '@/components/timeline/timeline-track';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTimeline } from '@/hooks/use-graph';
import { fmtTime } from '@/lib/format';
import { PRESETS, presetTime, stepTick } from '@/lib/timeline';
import { type TimeWindow, zoomWindow } from '@/lib/timeline-window';

/**
 * The docked time-travel control. It owns no time state — `asOf` lives in the URL, so a
 * time-travelled view is shareable and the Back button walks the scrub history.
 */
export function TimelineBar({
	tenant,
	project,
	axis = 'valid',
	label,
	asOf,
	onChange,
	onPlayingChange,
	rendererBusy,
}: {
	tenant: string;
	project: string;
	/** Which time the bar scrubs: the world (`valid`) or what the graph believed (`recorded`). */
	axis?: 'valid' | 'recorded';
	/** Names the bar when more than one is docked. */
	label?: string;
	/** The current instant on this bar's axis; `undefined` ⇒ now. */
	asOf?: number;
	onChange: (asOf: number | undefined) => void;
	/** Reports playback so the canvas can hold its simulation still while the slice churns. */
	onPlayingChange?: (playing: boolean) => void;
	/**
	 * Whether the renderer is still taking in the slice from the previous step. Playback holds
	 * while it is true; renderers that absorb a slice synchronously (the flow canvas) never report
	 * it, and playback must not depend on the signal being wired at all.
	 */
	rendererBusy?: boolean;
}) {
	// The scrub window. `{}` is the full extent. Narrowing it makes the server return exact ticks
	// for that span instead of a sample, which is the only way to snap precisely on a dense graph.
	const [zoom, setZoom] = useState<TimeWindow>({});
	const timeline = useTimeline(tenant, project, zoom, axis);
	const isMobile = useIsMobile();
	const [preview, setPreview] = useState<number | undefined>(undefined);

	const data = timeline.data;
	const empty = !data || data.min === null || data.max === null;
	const from = data?.from ?? 0;
	const to = data?.to ?? 0;
	const ticks = data?.ticks ?? [];
	const current = asOf ?? to;
	const shown = preview ?? asOf;
	const zoomed = zoom.from !== undefined || zoom.to !== undefined;

	const [playing, setPlaying] = useState(false);

	// The timer reads its inputs through a ref rather than closing over them. `onChange` is an
	// inline arrow at the call site, so listing it as a dependency would tear the interval down and
	// rebuild it on every parent render — a 700ms timer that keeps restarting never fires.
	const latest = useRef({ ticks, current, onChange, rendererBusy });
	latest.current = { ticks, current, onChange, rendererBusy };

	// Advance tick-to-tick. 700ms is the *minimum* dwell, not the rate: a step is skipped while the
	// renderer is still ingesting the previous one, so playback runs at the speed the graph can
	// actually be drawn. Pushing frames faster than that is what corrupts the WebGL canvas's
	// DuckDB catalog — see the handover gate in `graph-canvas.tsx` — and even where it survives it
	// only queues frames that get coalesced away unseen.
	useEffect(() => {
		if (!playing) return;
		const id = setInterval(() => {
			const { ticks: ts, current: now, onChange: emit, rendererBusy: busy } = latest.current;
			// Reaching the end stops playback whatever the renderer is doing — testing it after the
			// busy gate would leave the button stuck showing Pause on a run that has nowhere left to go.
			const next = stepTick(ts, now, 1);
			if (next === undefined) {
				setPlaying(false);
				return;
			}
			if (busy) return;
			emit(next);
		}, 700);
		return () => clearInterval(id);
	}, [playing]);

	useEffect(() => {
		onPlayingChange?.(playing);
		// If the bar unmounts mid-playback (e.g. the project switches), the parent's `playing` must
		// not stick on — there is no one left to turn it off otherwise.
		return () => onPlayingChange?.(false);
	}, [playing, onPlayingChange]);

	// Every manual interaction stops playback. The interval calls `onChange` directly so that it
	// does not pause itself on each step.
	const go = (t: number | undefined) => {
		setPlaying(false);
		onChange(t);
	};
	const step = (dir: -1 | 1) => {
		const next = stepTick(ticks, current, dir);
		if (next !== undefined) go(next);
	};
	// Zoom around what is being viewed, clamped to the extent (`min`/`max`), not to the window —
	// the window is what we are changing, and clamping to it would never let you widen.
	const doZoom = (factor: number) => {
		setPlaying(false);
		setZoom((w) => zoomWindow(w, current, factor, data?.min ?? 0, data?.max ?? 0));
	};
	const fullRange = () => {
		setPlaying(false);
		setZoom({});
	};

	// A 32px scrub track on a phone is not usable and the canvas needs the height more, so the bar
	// collapses to what it is showing plus the way back to live.
	if (isMobile) {
		return (
			<div className="flex items-center gap-2 border-t bg-background px-3 py-1.5 text-xs">
				{label && <span className="w-16 shrink-0 font-medium text-muted-foreground">{label}</span>}
				<span className="tabular-nums text-muted-foreground">
					{empty ? 'No history' : asOf === undefined ? 'Now' : fmtTime(asOf)}
				</span>
				<Button
					variant="ghost"
					size="xs"
					className="ml-auto"
					disabled={asOf === undefined}
					onClick={() => go(undefined)}
				>
					Now
				</Button>
			</div>
		);
	}

	return (
		<div className="flex items-center gap-3 border-t bg-background px-3 py-1.5">
			{label && (
				<span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
			)}
			<div className="flex items-center gap-0.5">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Previous change"
					disabled={empty || stepTick(ticks, current, -1) === undefined}
					onClick={() => step(-1)}
				>
					<HugeiconsIcon icon={PreviousIcon} strokeWidth={2} />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={playing ? 'Pause playback' : 'Play through changes'}
					disabled={empty || (!playing && stepTick(ticks, current, 1) === undefined)}
					onClick={() => setPlaying((p) => !p)}
				>
					<HugeiconsIcon icon={playing ? PauseIcon : PlayIcon} strokeWidth={2} />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Next change"
					disabled={empty || stepTick(ticks, current, 1) === undefined}
					onClick={() => step(1)}
				>
					<HugeiconsIcon icon={NextIcon} strokeWidth={2} />
				</Button>
			</div>

			<TimelineTrack
				buckets={data?.buckets ?? []}
				ticks={ticks}
				from={from}
				to={to}
				value={asOf}
				onChange={go}
				onPreview={setPreview}
				disabled={empty}
			/>

			<span className="w-36 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
				{empty ? 'No history' : shown === undefined ? 'Now' : fmtTime(shown)}
			</span>

			{/*
        The canvas toolbar already owns "Zoom in"/"Zoom out" for the viewport. These two act on the
        time range instead, so they carry names a screen reader can tell apart from those.
      */}
			<div className="flex shrink-0 items-center gap-0.5">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Narrow the time range"
					title={
						data?.ticksTruncated
							? 'Narrow the time range — it holds more changes than can be listed, so snapping is approximate until you zoom in'
							: 'Narrow the time range'
					}
					disabled={empty}
					onClick={() => doZoom(0.5)}
				>
					<HugeiconsIcon icon={ZoomInAreaIcon} strokeWidth={2} />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Widen the time range"
					title="Widen the time range"
					disabled={empty || !zoomed}
					onClick={() => doZoom(2)}
				>
					<HugeiconsIcon icon={ZoomOutAreaIcon} strokeWidth={2} />
				</Button>
				{zoomed && (
					<Button variant="ghost" size="xs" onClick={fullRange}>
						Full range
					</Button>
				)}
				{PRESETS.map((p) => (
					<Button
						key={p}
						variant="ghost"
						size="xs"
						disabled={empty}
						onClick={() => go(presetTime(p, Date.now()))}
					>
						{p}
					</Button>
				))}
				<Button
					variant="ghost"
					size="xs"
					disabled={asOf === undefined}
					onClick={() => go(undefined)}
				>
					Now
				</Button>
			</div>
		</div>
	);
}
