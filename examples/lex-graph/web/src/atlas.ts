/**
 * The Atlas's data layer: typed fetchers for `/atlas/*` (see `../../api.ts`), the TanStack Query
 * hooks over them, and the URL state every view is keyed on.
 */
import { useCallback, useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { GraphSlice } from '@/lib/types';

export type NodeKind = 'podcast' | 'episode' | 'person' | 'topic' | 'sponsor';

/** A node as every list shows it. Episode, person and show rows carry a little more. */
export interface Brief {
	id: string;
	type: NodeKind;
	label: string;
	image?: string;
	/** The show's key: an episode's show, or a show's own. */
	podcast?: string;
	// episode
	title?: string;
	number?: number;
	publishedAt?: string;
	guests?: string[];
	// person, show
	tagline?: string;
	// ranked lists
	count?: number;
	score?: number | null;
}

export interface Chapter {
	startSec: number;
	title: string;
}

export interface Mention extends Brief {
	chapter: string;
	startSec: number;
}

/** In a detail, an episode's `guests` are rows, not the names a `Brief` carries. */
export interface EpisodeDetail extends Omit<Brief, 'guests'> {
	type: 'episode';
	data: {
		title: string;
		summary: string;
		chapters: Chapter[];
		durationSec?: number;
		url: string;
		youtubeUrl?: string;
		transcriptUrl?: string;
		audioUrl?: string;
		tagline?: string;
		kind: string;
	};
	podcastNode?: Brief;
	guests: Brief[];
	topics: Brief[];
	sponsors: Brief[];
	mentions: Mention[];
}

export interface PersonDetail extends Brief {
	type: 'person';
	data: { name: string; tagline?: string };
	/** The shows they host. */
	hosts: Brief[];
	/** Short names of every show they were on or host. */
	shows: string[];
	episodes: Brief[];
	mentionedIn: Mention[];
}

export interface PodcastDetail extends Brief {
	type: 'podcast';
	data: { key: string; name: string; short: string; host: string; url: string; image?: string };
	hostedBy: Brief[];
	count: number;
	first?: string;
	last?: string;
	regulars: Brief[];
	latest: Brief[];
}

export interface GroupDetail extends Brief {
	type: 'topic' | 'sponsor';
	data: { name: string };
	episodes: Brief[];
	first?: string;
	last?: string;
}

export type Detail = EpisodeDetail | PersonDetail | PodcastDetail | GroupDetail;

export interface Overview {
	counts: { podcasts: number; episodes: number; people: number; topics: number; sponsors: number };
	podcasts: Brief[];
	regulars: Brief[];
	mentioned: Brief[];
	/** People on more than one show, as a guest or a host. */
	crossovers: Array<Brief & { shows: string[] }>;
	topics: Brief[];
	sponsors: Brief[];
	latest: Brief[];
}

async function atlas<T>(path: string, params: Record<string, string | number | undefined> = {}) {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params))
		if (v !== undefined && v !== '') qs.set(k, String(v));
	const res = await fetch(`/atlas${path}${qs.size ? `?${qs}` : ''}`);
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return (await res.json()) as T;
}

export function useConfig() {
	return useQuery({
		queryKey: ['atlas', 'config'],
		queryFn: () => atlas<{ tenant: string; project: string }>('/config'),
		staleTime: Infinity,
	});
}

/** What every read is narrowed by: the scrubber's instant and the one-show filter. */
export interface Scope {
	asOf?: number;
	podcast?: string;
}

export function useOverview(scope: Scope) {
	return useQuery({
		queryKey: ['atlas', 'overview', scope.asOf, scope.podcast],
		queryFn: () => atlas<Overview>('/overview', { ...scope }),
		placeholderData: keepPreviousData,
	});
}

/** Every show in the graph, whatever the filter: the filter's own options. */
export function useShows() {
	return useQuery({
		queryKey: ['atlas', 'overview', undefined, undefined],
		queryFn: () => atlas<Overview>('/overview'),
		select: (o) => o.podcasts,
		staleTime: Infinity,
	});
}

export function useSearch(q: string, scope: Scope) {
	return useQuery({
		queryKey: ['atlas', 'search', q, scope.asOf, scope.podcast],
		queryFn: () => atlas<{ results: Brief[] }>('/search', { q, ...scope }),
		enabled: q.trim().length > 1,
		placeholderData: keepPreviousData,
	});
}

export function useDetail(id: string | undefined, scope: Scope) {
	return useQuery({
		queryKey: ['atlas', 'node', id, scope.asOf, scope.podcast],
		queryFn: () => atlas<Detail>(`/node/${id}`, { ...scope }),
		enabled: Boolean(id),
		retry: false,
	});
}

export function useSlice(opts: Scope & { focus?: string; depth: number; sponsors: boolean }) {
	return useQuery({
		queryKey: ['atlas', 'slice', opts],
		queryFn: () =>
			atlas<GraphSlice>('/slice', {
				focus: opts.focus,
				depth: opts.depth,
				sponsors: opts.sponsors ? 1 : undefined,
				asOf: opts.asOf,
				podcast: opts.podcast,
			}),
		// Hold the last slice on screen while the next loads: the canvas never blanks mid-scrub.
		placeholderData: keepPreviousData,
	});
}

export function usePath(from: string | undefined, to: string | undefined, scope: Scope) {
	return useQuery({
		queryKey: ['atlas', 'path', from, to, scope.asOf, scope.podcast],
		queryFn: () =>
			atlas<{ path: Brief[] | null; slice: GraphSlice }>('/path', { from, to, ...scope }),
		enabled: Boolean(from && to),
	});
}

// --- URL state -----------------------------------------------------------------------------------

/** Everything a view is, in the query string — so any view is a link. */
export interface ViewState {
	mode: 'explore' | 'path';
	/** The node the canvas is centered on; absent ⇒ the whole graph. */
	focus?: string;
	/** The node the detail panel shows. */
	sel?: string;
	depth: number;
	sponsors: boolean;
	asOf?: number;
	/** One show's key, or absent for every show. */
	podcast?: string;
	from?: string;
	to?: string;
}

function read(): ViewState {
	const p = new URLSearchParams(window.location.search);
	const num = (k: string) => {
		const v = p.get(k);
		return v === null || !Number.isFinite(Number(v)) ? undefined : Number(v);
	};
	return {
		mode: p.get('mode') === 'path' ? 'path' : 'explore',
		focus: p.get('focus') ?? undefined,
		sel: p.get('sel') ?? undefined,
		depth: Math.min(3, Math.max(1, num('depth') ?? 2)),
		sponsors: p.get('sponsors') === '1',
		asOf: num('asOf'),
		podcast: p.get('podcast') ?? undefined,
		from: p.get('from') ?? undefined,
		to: p.get('to') ?? undefined,
	};
}

function write(s: ViewState): string {
	const p = new URLSearchParams();
	if (s.mode === 'path') p.set('mode', 'path');
	if (s.focus) p.set('focus', s.focus);
	if (s.sel) p.set('sel', s.sel);
	if (s.depth !== 2) p.set('depth', String(s.depth));
	if (s.sponsors) p.set('sponsors', '1');
	if (s.asOf !== undefined) p.set('asOf', String(s.asOf));
	if (s.podcast) p.set('podcast', s.podcast);
	if (s.from) p.set('from', s.from);
	if (s.to) p.set('to', s.to);
	return p.size ? `?${p}` : window.location.pathname;
}

/**
 * The view, read from and written to the URL. Focus, mode and show changes push a history entry
 * (Back walks them); selection and scrubbing replace it, so Back is not a replay of every click.
 */
export function useViewState() {
	const [state, setState] = useState<ViewState>(read);
	useEffect(() => {
		const onPop = () => setState(read());
		window.addEventListener('popstate', onPop);
		return () => window.removeEventListener('popstate', onPop);
	}, []);
	const update = useCallback((patch: Partial<ViewState>) => {
		setState((prev) => {
			const next = { ...prev, ...patch };
			const push =
				next.focus !== prev.focus || next.mode !== prev.mode || next.podcast !== prev.podcast;
			window.history[push ? 'pushState' : 'replaceState'](null, '', write(next));
			return next;
		});
	}, []);
	return [state, update] as const;
}

// --- formatting ----------------------------------------------------------------------------------

export const fmtDate = (iso?: string) =>
	iso
		? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
		: '';

export const fmtClock = (sec: number) => {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	const mm = String(m).padStart(h ? 2 : 1, '0');
	return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
};

/** A YouTube link that starts at `sec`. */
export const atTime = (youtubeUrl: string | undefined, sec: number) =>
	youtubeUrl ? `${youtubeUrl}${youtubeUrl.includes('?') ? '&' : '?'}t=${sec}s` : undefined;
