import { createContext, useContext } from 'react';
import type { Edits, Meta, Network, Scenario } from './api.ts';

export type Tab =
	| 'traffic'
	| 'route'
	| 'commutes'
	| 'scenarios'
	| 'critical'
	| 'safety'
	| 'transit'
	| 'changes';

export type Selection =
	| { kind: 'intersection'; id: string }
	| { kind: 'zone'; key: string }
	| { kind: 'segment'; index: number }
	| null;

export interface IntersectionInfo {
	id: string;
	key: string;
	name: string;
	lat: number;
	lng: number;
	signal: {
		cycleSec: number;
		green: Record<string, number>;
		name: string;
		cityId: number;
		synthetic: boolean;
	} | null;
}

export interface App {
	meta: Meta;
	theme: 'dark' | 'light';
	tab: Tab;
	setTab(t: Tab): void;
	/** The instant the map shows (epoch ms) — the start of a modelled window. */
	t: number;
	setT(t: number): void;
	/** The project the map reads: the baseline, or a scenario branch. */
	project: string;
	scenario: Scenario | null;
	setScenario(s: Scenario | null): void;
	scenarios: Scenario[];
	selected: Selection;
	select(s: Selection): void;
	flyTo(lng: number, lat: number, zoom?: number): void;
	network: Network;
	intersections: Map<string, IntersectionInfo>;
	/** Scenario builder: the edits being drafted. */
	draft: Edits;
	setDraft(e: Edits): void;
	route: { from: string | null; to: string | null };
	setRoute(r: { from: string | null; to: string | null }): void;
}

export const AppContext = createContext<App | null>(null);
export function useApp(): App {
	const a = useContext(AppContext);
	if (!a) throw new Error('useApp outside AppContext');
	return a;
}

/** Minutes after midnight (Boston) of a modelled instant. */
export const minuteOf = (meta: Meta, t: number) => Math.round((t - meta.day) / 60_000);
