/**
 * The social card — the 1200x630 image LinkedIn, X, Slack and iMessage show
 * when the site is shared.
 *
 * It is drawn here rather than exported from a design tool so that it is built
 * from the same README the page is built from: change the tagline and the next
 * deploy carries it onto every share. Satori lays the card out and resvg
 * rasterises it, both in plain JavaScript — a headless browser would be the
 * obvious way to render HTML to a PNG, but the deploy has no browser, and a
 * committed PNG would go stale the first time the README changed.
 *
 * See vite.config.ts, which emits this at /og.png in dev and in the bundle.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import typescript from '@shikijs/langs/typescript';
import vitesseDark from '@shikijs/themes/vitesse-dark';
import satori from 'satori';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * 1200x630 is the size both LinkedIn and X document, and the one every other
 * unfurler falls back to. Declared in index.html too — the platforms drop cards
 * whose declared dimensions disagree with the file.
 */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const BG = '#0a0a0a';
const RAISED = '#0f0f0f';
const BORDER = '#2e2e2e';
const DIM = '#8f8f8f';
const BODY = '#b5b5b5';

const EYEBROW = 'TEMPORAL GRAPHRAG · LIBSQL · POSTGRES · DUCKDB';
const INSTALL = 'bun add graphx';

/**
 * The card's right-hand crop. graphx is a library, so what it looks like is the
 * code you write against it — the same thing the page's hero card shows, and
 * the same lines, so the two agree.
 *
 * Sized for a feed: a card is about 550px wide in a LinkedIn timeline, so this
 * is set at 21px here to land near 10px there — legible as code, not as prose,
 * which is all the crop is asked to do.
 */
const SNIPPET = `const schema = defineGraphSchema({
  nodes: { site: z.object({ name: z.string() }) },
  edges: { deployedAt: { from: 'gateway', to: 'site' } },
});

// Typed mutations, no codegen
await g.addNode({ type: 'site', data: { name: 'us-east-1' } });

// Bitemporal by construction
await history(db, id);
await diff(db, t1, t2);

// GraphRAG: vector seeds, then a time-respecting walk
await g.retrieve({ query: 'overheating sensor', k: 10 });`;

const CODE_SIZE = 21;
const CODE_LINE = 34;

/**
 * The three claims from the page's pitch band, cut to a card's attention span.
 * These restate `PILLARS` in prerender.ts — keep them in step.
 */
const CLAIMS = 'Zod in, everything else inferred.';
const CLAIMS_2 =
	'Typed mutations, retrieval, an HTTP API, React hooks and an MCP server — over SQLite, Postgres or DuckDB.';

/**
 * Satori takes React elements, but only reads `type`/`props` off them — so the
 * card is written as plain objects and the site keeps its no-JSX build.
 */
type Node = {
	type: string;
	props: Record<string, unknown> & { children?: unknown };
};

function el(type: string, props: Record<string, unknown>, ...children: unknown[]): Node {
	return {
		type,
		props: {
			...props,
			...(children.length ? { children: children.length === 1 ? children[0] : children } : {}),
		},
	};
}

/** Satori needs woff/ttf/otf — the woff2 files @fontsource ships are not read. */
async function loadFont(siteDir: string, pkg: string, file: string) {
	return readFile(path.join(siteDir, 'node_modules/@fontsource', pkg, 'files', file));
}

/**
 * The snippet, tokenised by the same highlighter and the same theme the page
 * uses, so the card's colours are the docs' colours rather than a second
 * palette invented here.
 *
 * Satori has no inline flow: it lays text out as flex items. So each line is a
 * row and each token a `pre`-spaced span, which is also what keeps the leading
 * indentation from being collapsed.
 */
async function codeRows() {
	const highlighter = await createHighlighterCore({
		themes: [vitesseDark],
		langs: [typescript],
		engine: createJavaScriptRegexEngine({ forgiving: true }),
	});
	const { tokens } = highlighter.codeToTokens(SNIPPET, {
		lang: 'typescript',
		theme: 'vitesse-dark',
	});

	return tokens.map((line) =>
		el(
			'div',
			{
				style: {
					display: 'flex',
					height: CODE_LINE,
					alignItems: 'center',
				},
			},
			// An empty line has no tokens, and satori drops a childless flex row
			// to zero height — the blank line has to be a space to hold its slot.
			...(line.length
				? line.map((token) =>
						el(
							'span',
							{
								style: {
									// Without this satori compresses the row to fit the
									// window and the tokens overlap — punctuation lands
									// on top of the identifier beside it. The row is
									// meant to overflow and be clipped, not to shrink.
									flexShrink: 0,
									whiteSpace: 'pre',
									fontFamily: 'Geist Mono',
									fontSize: CODE_SIZE,
									color: token.color ?? BODY,
								},
							},
							token.content,
						),
					)
				: [el('span', { style: { whiteSpace: 'pre' } }, ' ')]),
		),
	);
}

/** The nav's mark, inlined as a data URI — satori renders `img`, not `svg`. */
function markUri(size: number) {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round">` +
		`<path d="M3.4 10.8 9 3.6l3.6 8Z"/>` +
		`<circle cx="3.4" cy="10.8" r="2.1" fill="#ffffff" stroke="none"/>` +
		`<circle cx="9" cy="3.6" r="1.6" fill="#ffffff" stroke="none"/>` +
		`<circle cx="12.6" cy="11.6" r="1.6" fill="#ffffff" stroke="none"/>` +
		`</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function card(lede: string, rows: Node[]): Node {
	return el(
		'div',
		{
			style: {
				width: CARD_WIDTH,
				height: CARD_HEIGHT,
				display: 'flex',
				position: 'relative',
				background: BG,
				fontFamily: 'Geist',
				color: '#ededed',
			},
		},
		// A hairline grid behind the copy, fading out before it reaches the code
		// window — the same backdrop the page's own hero sits on.
		el('div', {
			style: {
				position: 'absolute',
				top: 0,
				left: 0,
				width: 700,
				height: 380,
				backgroundImage:
					'linear-gradient(to right, #1f1f1f 1px, transparent 1px), linear-gradient(to bottom, #1f1f1f 1px, transparent 1px)',
				backgroundSize: '48px 48px, 48px 48px',
				opacity: 0.5,
			},
		}),
		el('div', {
			style: {
				position: 'absolute',
				top: 0,
				left: 0,
				width: 700,
				height: 380,
				backgroundImage: `radial-gradient(120% 90% at 0% 0%, rgba(10,10,10,0) 0%, ${BG} 62%)`,
			},
		}),

		// The code window, running off the right and bottom edges. A crop rather
		// than a shrunk-to-fit thumbnail: at feed size a whole file reduced to
		// the width of a business card is a grey smudge, but a crop of it still
		// reads as code someone wrote.
		el(
			'div',
			{
				style: {
					position: 'absolute',
					top: 96,
					left: 648,
					width: 620,
					height: 534,
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
					borderTop: `1px solid ${BORDER}`,
					borderLeft: `1px solid ${BORDER}`,
					borderTopLeftRadius: 12,
					background: RAISED,
				},
			},
			el(
				'div',
				{
					style: {
						display: 'flex',
						alignItems: 'center',
						height: 46,
						paddingLeft: 20,
						borderBottom: '1px solid #1f1f1f',
						fontFamily: 'Geist Mono',
						fontSize: 14,
						letterSpacing: '0.08em',
						color: DIM,
					},
				},
				'SCHEMA.TS',
			),
			el(
				'div',
				{
					style: {
						display: 'flex',
						flexDirection: 'column',
						paddingTop: 18,
						paddingLeft: 22,
					},
				},
				...rows,
			),
		),
		// Keeps the copy readable where the window would otherwise crowd it.
		el('div', {
			style: {
				position: 'absolute',
				top: 0,
				left: 540,
				width: 130,
				height: CARD_HEIGHT,
				backgroundImage: `linear-gradient(to right, ${BG} 20%, rgba(10,10,10,0))`,
			},
		}),

		el(
			'div',
			{
				style: {
					position: 'absolute',
					top: 0,
					left: 64,
					width: 540,
					height: CARD_HEIGHT,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
				},
			},
			el(
				'div',
				{ style: { display: 'flex', alignItems: 'center', marginBottom: 30 } },
				el('img', { src: markUri(26), width: 26, height: 26 }),
				el(
					'span',
					{
						style: {
							marginLeft: 11,
							fontWeight: 600,
							fontSize: 25,
							letterSpacing: '-0.02em',
							color: '#ffffff',
						},
					},
					'graphx',
				),
			),
			el(
				'div',
				{ style: { display: 'flex', alignItems: 'center', marginBottom: 18 } },
				el('div', {
					style: {
						width: 7,
						height: 7,
						marginRight: 10,
						borderRadius: 4,
						background: '#ffffff',
					},
				}),
				el(
					'span',
					{
						style: {
							fontFamily: 'Geist Mono',
							fontSize: 13,
							letterSpacing: '0.09em',
							color: DIM,
						},
					},
					EYEBROW,
				),
			),
			el(
				'div',
				{
					style: {
						marginBottom: 20,
						fontSize: 42,
						fontWeight: 600,
						lineHeight: 1.1,
						letterSpacing: '-0.033em',
						color: '#ffffff',
					},
				},
				lede,
			),
			el(
				'div',
				{
					style: {
						fontSize: 23,
						lineHeight: 1.45,
						letterSpacing: '-0.008em',
						color: BODY,
					},
				},
				CLAIMS,
			),
			el(
				'div',
				{
					style: {
						marginTop: 4,
						fontSize: 23,
						lineHeight: 1.45,
						letterSpacing: '-0.008em',
						color: BODY,
					},
				},
				CLAIMS_2,
			),
			el(
				'div',
				{
					style: {
						display: 'flex',
						alignItems: 'center',
						alignSelf: 'flex-start',
						marginTop: 34,
						padding: '12px 18px',
						border: `1px solid ${BORDER}`,
						borderRadius: 10,
						background: RAISED,
						fontFamily: 'Geist Mono',
						fontSize: 20,
						color: '#ededed',
					},
				},
				el('span', { style: { marginRight: 11, color: DIM } }, '$'),
				INSTALL,
			),
		),
	);
}

/**
 * The card's headline: the first sentence of the README's tagline, which is the
 * one clause that says what this is.
 */
function readLede(readme: string) {
	const lines = readme.split(/\r?\n/).slice(1);
	const paragraph: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (line.startsWith('#')) break;
		if (!line || line.startsWith('[') || line.startsWith('!')) {
			if (paragraph.length) break;
			continue;
		}
		paragraph.push(line);
	}
	const tagline = paragraph.join(' ');
	return (tagline.split(/(?<=\.)\s/)[0] ?? tagline).replace(/\.$/, '');
}

/** resvg's wasm module is global and initialises once per process. */
let wasmReady: Promise<unknown> | undefined;

/** Renders the card to PNG bytes. */
export async function renderCard(siteDir: string): Promise<Buffer> {
	const repoRoot = path.resolve(siteDir, '..');
	const [readme, rows, sans400, sans600, mono400, mono500] = await Promise.all([
		readFile(path.join(repoRoot, 'README.md'), 'utf8'),
		codeRows(),
		loadFont(siteDir, 'geist-sans', 'geist-sans-latin-400-normal.woff'),
		loadFont(siteDir, 'geist-sans', 'geist-sans-latin-600-normal.woff'),
		loadFont(siteDir, 'geist-mono', 'geist-mono-latin-400-normal.woff'),
		loadFont(siteDir, 'geist-mono', 'geist-mono-latin-500-normal.woff'),
	]);

	const svg = await satori(card(readLede(readme), rows) as never, {
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		fonts: [
			{ name: 'Geist', data: sans400, weight: 400, style: 'normal' },
			{ name: 'Geist', data: sans600, weight: 600, style: 'normal' },
			{ name: 'Geist Mono', data: mono400, weight: 400, style: 'normal' },
			{ name: 'Geist Mono', data: mono500, weight: 500, style: 'normal' },
		],
	});

	if (!wasmReady) {
		wasmReady = initWasm(
			readFile(path.join(siteDir, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')),
		);
	}
	await wasmReady;

	return Buffer.from(
		new Resvg(svg, {
			fitTo: { mode: 'width', value: CARD_WIDTH },
			background: BG,
		})
			.render()
			.asPng(),
	);
}
