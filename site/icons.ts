/**
 * Icons are markup, so they live here; which icon a thing uses is content (see `IconName` in
 * content.ts). Two sets, never mixed: stroked glyphs on a 24 grid, and solid brand marks
 * (simple-icons, CC0) that fill with currentColor.
 */

import * as si from 'simple-icons';
import type { EcoName } from './content.ts';

/** Real marks, solid. LinkedIn is from simple-icons v13, the last release that shipped it. */
export const BRAND_PATHS = {
	github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
	x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
	linkedin: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
	discord: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
} as const;

export type BrandName = keyof typeof BRAND_PATHS;

const ECO: Record<EcoName, { path: string }> = {
	sqlite: si.siSqlite,
	postgresql: si.siPostgresql,
	duckdb: si.siDuckdb,
	bun: si.siBun,
	nodedotjs: si.siNodedotjs,
	webassembly: si.siWebassembly,
	expo: si.siExpo,
	react: si.siReact,
	reactquery: si.siReactquery,
	zod: si.siZod,
	hono: si.siHono,
	openapiinitiative: si.siOpenapiinitiative,
	modelcontextprotocol: si.siModelcontextprotocol,
	ollama: si.siOllama,
};

/** An ecosystem mark. Every one is single-colour in simple-icons, so all stay currentColor. */
export function ecoIcon(name: EcoName, size = 40): string {
	return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false"><path d="${ECO[name].path}"/></svg>`;
}

/** One stroked set: 24 grid, 1.7 stroke, round caps. Buttons and controls carry one. */
export const GLYPH_PATHS = {
	copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
	check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
	book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/>',
	chevron: '<path d="m6 9 6 6 6-6"/>',
	sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
	moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
	monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
	terminal: '<path d="m5 8 4 4-4 4"/><path d="M12 17h7"/>',
	arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
	file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
} as const;

export type GlyphName = keyof typeof GLYPH_PATHS;

export function brandIcon(name: BrandName, size = 18): string {
	return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false"><path d="${BRAND_PATHS[name]}"/></svg>`;
}

export function glyph(name: GlyphName, size = 16, extra = ''): string {
	return `<svg class="glyph${extra ? ` ${extra}` : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${GLYPH_PATHS[name]}</svg>`;
}

/** The product mark: a closed triad, three nodes and three edges — the smallest drawing that reads as a graph. */
const MARK_BODY =
	'<path d="M3.4 10.8 9 3.6l3.6 8Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="3.4" cy="10.8" r="2.1" fill="currentColor"/><circle cx="9" cy="3.6" r="1.6" fill="currentColor"/><circle cx="12.6" cy="11.6" r="1.6" fill="currentColor"/>';

/** A rounded --raise tile holding the mark; it anchors the H1 and is the page's only decoration. */
export function productMark(size = 44): string {
	return `<span class="mark" style="--mark:${size}px"><svg viewBox="0 0 16 16" width="${Math.round(size * 0.5)}" height="${Math.round(size * 0.5)}" aria-hidden="true" focusable="false">${MARK_BODY}</svg></span>`;
}

/** The favicon: the mark alone, inked for both schemes through a media query. */
export const FAVICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><style>g{color:#171717}@media(prefers-color-scheme:dark){g{color:#fff}}</style><g>' +
	MARK_BODY +
	'</g></svg>';
