import { useEffect, useState } from 'react';
import type { Route } from './api.ts';

/** Categorical slots 1–3 of the validated reference palette (all-pairs safe), stepped per mode. */
const SLOTS = {
	light: ['#2a78d6', '#eb6834', '#1baf7a'],
	dark: ['#3987e5', '#d95926', '#199e70'],
};

export function useMode(): 'light' | 'dark' {
	const query = '(prefers-color-scheme: dark)';
	const [dark, setDark] = useState(() => matchMedia(query).matches);
	useEffect(() => {
		const m = matchMedia(query);
		const on = () => setDark(m.matches);
		m.addEventListener('change', on);
		return () => m.removeEventListener('change', on);
	}, []);
	return dark ? 'dark' : 'light';
}

/** Colour follows the route family, never its rank. */
export function routeColors(mode: 'light' | 'dark'): Record<Route, string> {
	const s = SLOTS[mode];
	return { BHC: s[0]!, Boots: s[1]!, Flow: s[2]! };
}

export const ROUTE_ORDER: Route[] = ['Boots', 'BHC', 'Flow'];
