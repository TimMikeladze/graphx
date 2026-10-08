import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
	Cancel01Icon,
	Clock01Icon,
	Globe02Icon,
	Route01Icon,
	Target02Icon,
} from '@hugeicons/core-free-icons';
import { GraphShell } from '@/components/graph-shell';
import { TimelineBar } from '@/components/timeline/timeline-bar';
import { Button } from '@/components/ui/button';
import { colorForType } from '@/lib/graph-style';
import { cn } from '@/lib/utils';
import type { FlowLayout, Renderer } from '@/lib/types';
import {
	type Brief,
	fmtDate,
	type Scope,
	useConfig,
	useDetail,
	usePath,
	useShows,
	useSlice,
	useViewState,
} from '~/atlas';
import { DetailPanel } from '~/components/detail-panel';
import { OverviewPanel } from '~/components/overview-panel';
import { PathPanel } from '~/components/path-panel';
import { SearchBox } from '~/components/search-box';

/** The first person whose name matches — how the path finder's example pairs become ids. */
async function personId(name: string): Promise<string | undefined> {
	const res = await fetch(`/atlas/search?q=${encodeURIComponent(name)}`);
	const { results } = (await res.json()) as { results: Brief[] };
	return results.find((r) => r.type === 'person')?.id;
}

export function App() {
	const [view, setView] = useViewState();
	const config = useConfig();
	const [renderer, setRenderer] = useState<Renderer>(view.mode === 'path' ? 'flow' : 'cosmograph');
	const [flowLayout, setFlowLayout] = useState<FlowLayout>('layered');
	const [playing, setPlaying] = useState(false);
	const [busy, setBusy] = useState(false);
	const [browseOpen, setBrowseOpen] = useState(false);

	const explore = view.mode === 'explore';
	const scope: Scope = { asOf: view.asOf, podcast: view.podcast };
	const shows = useShows().data ?? [];
	const slice = useSlice({
		...scope,
		focus: view.focus,
		depth: view.depth,
		sponsors: view.sponsors,
	});
	const path = usePath(explore ? undefined : view.from, explore ? undefined : view.to, scope);
	const focusNode = useDetail(view.focus, scope).data;

	// A path reads best as a ranked chain; the whole graph only fits the WebGL canvas.
	useEffect(() => setRenderer(explore ? 'cosmograph' : 'flow'), [explore]);

	const select = (n: Brief | string | undefined) =>
		setView({ sel: typeof n === 'string' ? n : n?.id });
	/** Picking from search or a list both selects the node and centers the graph on it. */
	const open = (n: Brief) => {
		setView({ sel: n.id, focus: explore ? n.id : view.focus });
		setBrowseOpen(false);
	};
	const shown = explore ? slice.data : path.data?.slice;

	return (
		<div className="dark flex h-dvh flex-col bg-background text-foreground">
			{/* --- header ------------------------------------------------------------------------- */}
			<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-4">
				<a href="/" className="flex shrink-0 items-center gap-2" aria-label="Podcast Atlas home">
					<span className="grid size-7 place-items-center rounded-md bg-muted ring-1 ring-border">
						<svg viewBox="0 0 32 32" className="size-5" aria-hidden>
							<circle cx="9" cy="10" r="4" fill="#60a5fa" />
							<circle cx="23" cy="9" r="3" fill="#a3e635" />
							<circle cx="16" cy="23" r="5" fill="#22d3ee" />
							<path d="M9 10L16 23L23 9" stroke="#ffffff55" strokeWidth="1.5" fill="none" />
						</svg>
					</span>
					<span className="hidden leading-tight sm:block">
						<span className="block text-sm font-semibold">Podcast Atlas</span>
						<span className="block text-[0.6875rem] text-muted-foreground">
							Lex Fridman and Sean Carroll's Mindscape as one graph
						</span>
					</span>
				</a>
				<SearchBox className="mx-auto w-full max-w-md" scope={scope} onPick={open} />
				{shows.length > 1 && (
					<div
						className="flex shrink-0 rounded-md border border-border p-0.5"
						role="group"
						aria-label="Show filter"
					>
						{[
							{ key: undefined, label: 'All' },
							...shows.map((p) => ({ key: p.podcast, label: p.label })),
						].map(({ key, label }) => (
							<button
								key={key ?? 'all'}
								type="button"
								title={key ? `Only ${label}` : 'Every show'}
								onClick={() => setView({ podcast: key, focus: undefined, sel: undefined })}
								className={cn(
									'rounded px-2.5 py-1 text-xs whitespace-nowrap transition-colors',
									view.podcast === key
										? 'bg-accent font-medium text-foreground'
										: 'text-muted-foreground hover:text-foreground',
								)}
							>
								{key ? label.replace(/^Sean Carroll's /, '').replace(/ Podcast$/, '') : label}
							</button>
						))}
					</div>
				)}
				<div className="flex shrink-0 rounded-md border border-border p-0.5">
					{(
						[
							['explore', 'Explore', Globe02Icon],
							['path', 'Path', Route01Icon],
						] as const
					).map(([mode, label, icon]) => (
						<button
							key={mode}
							type="button"
							onClick={() => setView({ mode })}
							className={cn(
								'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
								view.mode === mode
									? 'bg-accent font-medium text-foreground'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							<HugeiconsIcon icon={icon} className="size-3.5" />
							<span className="hidden sm:inline">{label}</span>
						</button>
					))}
				</div>
			</header>

			<div className="relative flex min-h-0 flex-1">
				{/* --- left: overview / path finder ------------------------------------------------ */}
				<aside
					className={cn(
						'w-[19rem] shrink-0 overflow-y-auto border-r border-border bg-background',
						'max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:z-30 max-lg:shadow-2xl',
						!browseOpen && 'max-lg:hidden',
					)}
				>
					{explore ? (
						<OverviewPanel scope={scope} selected={view.sel} onSelect={open} />
					) : (
						<PathPanel
							from={view.from}
							to={view.to}
							scope={scope}
							selected={view.sel}
							onChange={(p) => setView(p)}
							onSelect={(n) => select(n)}
							onExample={async (a, b) => {
								const [from, to] = await Promise.all([personId(a), personId(b)]);
								// The examples cross shows, so they read the whole graph.
								setView({ from, to, podcast: undefined });
							}}
						/>
					)}
				</aside>

				{/* --- center: the admin's graph canvas + time-travel bar --------------------------- */}
				<main className="relative flex min-w-0 flex-1 flex-col">
					<div className="pointer-events-none absolute top-14 right-14 left-3 z-20 flex flex-wrap items-start justify-end gap-2 sm:top-3 sm:left-auto">
						<Button
							variant="outline"
							size="sm"
							className="pointer-events-auto lg:hidden"
							onClick={() => setBrowseOpen((o) => !o)}
						>
							{explore ? 'Browse' : 'Path finder'}
						</Button>
						{explore && view.focus && (
							<div className="hud pointer-events-auto flex items-center gap-2 px-2 py-1 text-xs">
								<HugeiconsIcon icon={Target02Icon} className="size-3.5 text-muted-foreground" />
								<span
									className="inline-block size-2 rounded-full"
									style={{ backgroundColor: colorForType(focusNode?.type ?? 'person') }}
								/>
								<span className="max-w-48 truncate font-medium">{focusNode?.label ?? '…'}</span>
								<span className="text-muted-foreground">within</span>
								<div className="flex rounded border border-border">
									{[1, 2, 3].map((d) => (
										<button
											key={d}
											type="button"
											onClick={() => setView({ depth: d })}
											className={cn(
												'px-1.5 tabular-nums',
												view.depth === d
													? 'bg-accent text-foreground'
													: 'text-muted-foreground hover:text-foreground',
											)}
											aria-label={`${d} hops`}
										>
											{d}
										</button>
									))}
								</div>
								<span className="text-muted-foreground">hops</span>
								<button
									type="button"
									onClick={() => setView({ focus: undefined })}
									className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
									aria-label="Show the whole graph"
									title="Show the whole graph"
								>
									<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
								</button>
							</div>
						)}
						{explore && (
							<label className="hud pointer-events-auto flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
								<input
									type="checkbox"
									checked={view.sponsors}
									onChange={(e) => setView({ sponsors: e.target.checked })}
									className="accent-current"
								/>
								sponsors
							</label>
						)}
						{view.asOf !== undefined && (
							<button
								type="button"
								onClick={() => setView({ asOf: undefined })}
								className="hud pointer-events-auto flex items-center gap-1.5 px-2 py-1 text-xs"
								title="Back to today"
							>
								<HugeiconsIcon icon={Clock01Icon} className="size-3.5 text-amber-400" />
								as of {fmtDate(new Date(view.asOf).toISOString())}
								<HugeiconsIcon icon={Cancel01Icon} className="size-3 text-muted-foreground" />
							</button>
						)}
					</div>

					<div className="min-h-0 flex-1">
						<GraphShell
							slice={shown}
							isLoading={
								explore ? slice.isLoading : Boolean(view.from && view.to) && path.isLoading
							}
							selectedId={view.sel}
							onSelect={(id) => select(id)}
							renderer={renderer}
							onRendererChange={setRenderer}
							flowLayout={flowLayout}
							onFlowLayoutChange={setFlowLayout}
							pinSimulation={playing}
							onRendererBusyChange={setBusy}
							timeline={
								config.data && (
									<TimelineBar
										tenant={config.data.tenant}
										project={config.data.project}
										asOf={view.asOf}
										onChange={(asOf) => setView({ asOf })}
										onPlayingChange={setPlaying}
										rendererBusy={busy}
									/>
								)
							}
						/>
					</div>
				</main>

				{/* --- right: detail ----------------------------------------------------------------- */}
				{view.sel && (
					<aside className="w-[24rem] shrink-0 border-l border-border bg-background max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full">
						<DetailPanel
							key={view.sel}
							id={view.sel}
							scope={scope}
							focused={explore && view.focus === view.sel}
							onSelect={(n) => select(n)}
							onFocus={(id) =>
								// On a phone the panel covers the canvas: centering closes it so the graph shows.
								setView({
									focus: id,
									mode: 'explore',
									sel: window.matchMedia('(max-width: 767px)').matches ? undefined : id,
								})
							}
							onClose={() => select(undefined)}
						/>
					</aside>
				)}
			</div>
		</div>
	);
}
