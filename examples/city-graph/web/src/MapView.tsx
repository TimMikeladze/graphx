import type { Layer, PickingInfo } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface MapHandle {
	flyTo(lng: number, lat: number, zoom?: number): void;
}

const STYLE = {
	dark: 'https://tiles.openfreemap.org/styles/dark',
	light: 'https://tiles.openfreemap.org/styles/positron',
};

/** The basemap (OpenFreeMap vector tiles, no key) under a deck.gl overlay of graph layers. */
export const MapView = forwardRef<
	MapHandle,
	{
		layers: Layer[];
		theme: 'dark' | 'light';
		onClick?: (info: PickingInfo) => void;
		getTooltip?: (info: PickingInfo) => string | null;
	}
>(function MapView({ layers, theme, onClick, getTooltip }, ref) {
	const el = useRef<HTMLDivElement>(null);
	const map = useRef<maplibregl.Map | null>(null);
	const overlay = useRef<MapboxOverlay | null>(null);
	const handlers = useRef({ onClick, getTooltip });
	handlers.current = { onClick, getTooltip };

	useEffect(() => {
		const m = new maplibregl.Map({
			container: el.current!,
			style: STYLE[theme],
			center: [-71.075, 42.325],
			zoom: 11.6,
			attributionControl: { compact: true },
		});
		const o = new MapboxOverlay({
			interleaved: false,
			layers: [],
			onClick: (info) => handlers.current.onClick?.(info),
			getTooltip: (info) => {
				const text = handlers.current.getTooltip?.(info);
				return text ? { text, className: 'deck-tip' } : null;
			},
		});
		m.addControl(o);
		m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
		map.current = m;
		overlay.current = o;
		// Dev only: lets a browser test drive the map.
		if (import.meta.env.DEV) (window as unknown as { __cityMap: maplibregl.Map }).__cityMap = m;
		return () => {
			m.remove();
			map.current = null;
		};
		// The map is created once; theme changes swap the style below.
		// biome-ignore lint/correctness/useExhaustiveDependencies: created once
	}, []);

	useEffect(() => {
		map.current?.setStyle(STYLE[theme]);
	}, [theme]);

	useEffect(() => {
		overlay.current?.setProps({ layers });
	}, [layers]);

	useImperativeHandle(ref, () => ({
		flyTo(lng, lat, zoom = 15) {
			map.current?.flyTo({ center: [lng, lat], zoom, duration: 900 });
		},
	}));

	return <div ref={el} className="map" />;
});
