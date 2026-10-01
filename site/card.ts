/**
 * The social card: a real 1200x630 opaque PNG drawn from the page's own tokens and its own claim.
 * Satori lays it out and resvg rasterises it — both plain JavaScript, so the build needs no browser.
 * Content is the model's: mark, H1, lede, then install chip · tagline · domain. No screenshot, no
 * gradient, no shadow, nothing below 20px.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';
import { origin, page } from './content.ts';
import { readInstall, readReadme, siteDir } from './readme.ts';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const PAPER = '#101010';
const RAISE = '#1c1c1c';
const LINE = '#2a2a2a';
const INK = '#fafafa';
const BODY = '#bdbdbd';
const ACCENT = '#5e9eff';

type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, ...children: unknown[]): Node => ({
	type,
	props: {
		style,
		...(children.length ? { children: children.length === 1 ? children[0] : children } : {}),
	},
});

const markUri = () => {
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="32" height="32" fill="none" stroke="#fafafa" stroke-width="1.3" stroke-linejoin="round"><path d="M3.4 10.8 9 3.6l3.6 8Z"/><circle cx="3.4" cy="10.8" r="2.1" fill="#fafafa" stroke="none"/><circle cx="9" cy="3.6" r="1.6" fill="#fafafa" stroke="none"/><circle cx="12.6" cy="11.6" r="1.6" fill="#fafafa" stroke="none"/></svg>';
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

const font = (pkg: string, file: string) =>
	readFile(path.join(siteDir, 'node_modules/@fontsource', pkg, 'files', file));

let wasmReady: Promise<unknown> | undefined;

export async function renderCard(): Promise<Buffer> {
	const install = readInstall(await readReadme());
	const lede = page.description.split(/(?<=\.)\s/)[0] ?? page.description;
	const dot = el('span', { color: ACCENT, margin: '0 16px' }, '·');

	const root = el(
		'div',
		{
			width: CARD_WIDTH,
			height: CARD_HEIGHT,
			display: 'flex',
			flexDirection: 'column',
			justifyContent: 'space-between',
			background: PAPER,
			padding: 72,
			fontFamily: 'Geist',
			color: INK,
		},
		el(
			'div',
			{ display: 'flex', flexDirection: 'column' },
			el(
				'div',
				{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					width: 60,
					height: 60,
					borderRadius: 14,
					background: RAISE,
					border: `1px solid ${LINE}`,
				},
				{ type: 'img', props: { src: markUri(), width: 32, height: 32 } },
			),
			el(
				'div',
				{
					display: 'flex',
					marginTop: 44,
					width: 860,
					fontSize: 78,
					fontWeight: 700,
					lineHeight: 1.04,
					letterSpacing: '-0.04em',
				},
				page.h1,
			),
			el(
				'div',
				{ display: 'flex', marginTop: 28, width: 760, fontSize: 26, lineHeight: 1.4, color: BODY },
				lede,
			),
		),
		el(
			'div',
			{
				display: 'flex',
				alignItems: 'center',
				fontFamily: 'Geist Mono',
				fontSize: 22,
				color: BODY,
			},
			el(
				'div',
				{
					display: 'flex',
					padding: '10px 18px',
					background: RAISE,
					border: `1px solid ${LINE}`,
					borderRadius: 10,
					color: INK,
				},
				install,
			),
			dot,
			el('span', {}, page.tagline),
			dot,
			el('span', {}, origin.replace('https://', '')),
		),
	);

	const [sans600, sans700, mono400] = await Promise.all([
		font('geist-sans', 'geist-sans-latin-400-normal.woff'),
		font('geist-sans', 'geist-sans-latin-700-normal.woff'),
		font('geist-mono', 'geist-mono-latin-400-normal.woff'),
	]);
	const svg = await satori(root as never, {
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		fonts: [
			{ name: 'Geist', data: sans600, weight: 400, style: 'normal' },
			{ name: 'Geist', data: sans700, weight: 700, style: 'normal' },
			{ name: 'Geist Mono', data: mono400, weight: 400, style: 'normal' },
		],
	});
	wasmReady ??= initWasm(
		readFile(path.join(siteDir, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')),
	);
	await wasmReady;
	return Buffer.from(
		new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH }, background: PAPER })
			.render()
			.asPng(),
	);
}
