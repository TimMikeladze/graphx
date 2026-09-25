import { expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { boundaries, capabilities, links, page, repo, snippet, terminal, url } from './content.ts';
import { fencedBlocks, readInstall, readReadme, readSections, readTable, readVersion, resolve, siteDir } from './readme.ts';
import { buildModel, renderSite } from './render.ts';
import { css, bootScript, uiScript } from './styles.ts';

const pub = (f: string) => path.join(siteDir, 'public', f);
const read = (f: string) => readFileSync(pub(f), 'utf8');
const fresh = await renderSite();
const index = read('index.html');
const reference = read('reference.html');
const readme = await readReadme();
const blocks = fencedBlocks(readme);

test('every reference resolves to exactly one README block', () => {
	const refs = capabilities.flatMap((c) => (c.demo.kind === 'code' ? [c.demo.ref] : c.demo.kind === 'variants' ? c.demo.items.map((i) => i.ref) : []));
	expect(refs.length).toBeGreaterThan(8);
	for (const r of refs) expect(resolve(blocks, r).code.length).toBeGreaterThan(0);
	for (const c of capabilities) if (c.demo.kind === 'table') expect(readTable(readme, c.demo.header).rows.length).toBeGreaterThan(3);
});

test('an unresolved or ambiguous reference throws', () => {
	expect(() => resolve(blocks, terminal('graphx no-such-command'))).toThrow(/matched 0/);
	expect(() => resolve(blocks, snippet('await g.', 'x'))).toThrow(/matched ([2-9]|\d\d)/);
});

test('figures match their source: version and install command', async () => {
	expect(index).toContain(`Currently v${await readVersion()}`);
	expect(index).toContain(readInstall(readme));
});

test('both pages are self-contained with both token sets and a 3-state toggle', () => {
	for (const html of [index, reference]) {
		expect(html).not.toMatch(/<link[^>]+rel="(stylesheet|preload|icon|modulepreload)"[^>]+href="https?:/);
		expect(html).not.toMatch(/\bsrc="https?:/);
		const scripts = [...html.matchAll(/<script(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/g)];
		expect(scripts.length).toBe(2);
		expect((scripts[0]?.[1] ?? '').split('\n').length).toBeLessThan(30);
		expect(html).toContain('graphx-theme');
		expect(html).toContain(':root[data-theme="light"]');
		expect(html).toContain('@media (prefers-color-scheme: light)');
		expect(html).toContain('Theme: system. Click to change');
		expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<style>'));
		expect(html).toContain('media="(prefers-color-scheme: dark)"');
		expect(html).toContain('media="(prefers-color-scheme: light)"');
	}
	expect(bootScript.split('\n').length).toBeLessThan(30);
	expect(uiScript.length).toBeLessThan(2500);
});

// oklch → relative luminance
function lum(spec: string): number {
	const m = /oklch\(([\d.]+)% ([\d.]+) ?([\d.]*)\)/.exec(spec) as RegExpExecArray;
	const L = Number(m[1]) / 100, C = Number(m[2]), h = ((Number(m[3]) || 0) * Math.PI) / 180;
	const a = C * Math.cos(h), b = C * Math.sin(h);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s].map((v) => Math.min(1, Math.max(0, v)));
	return 0.2126 * (lin[0] as number) + 0.7152 * (lin[1] as number) + 0.0722 * (lin[2] as number);
}
const ratio = (a: string, b: string) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
	return (x + 0.05) / (y + 0.05);
};
test('body and --soft pass 4.5:1 against --paper in both schemes', () => {
	const tok = (block: RegExp, name: string) => (new RegExp(`--${name}: (oklch\\([^)]*\\))`).exec((block.exec(css) as RegExpExecArray)[0]) as RegExpExecArray)[1] as string;
	for (const block of [/:root \{[\s\S]*?\n\}/, /:root\[data-theme="light"\] \{[\s\S]*?\n\}/]) {
		for (const n of ['body', 'soft', 'ink']) expect(ratio(tok(block, n), tok(block, 'paper'))).toBeGreaterThan(4.5);
	}
});

test('markup in the source is escaped, never executed', async () => {
	const m = await buildModel();
	const html = m.md.parse('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>') as string;
	expect(html).not.toContain('<script');
	expect(html).not.toContain('<img');
});

test('committed output equals a fresh render', () => {
	for (const [name, text] of Object.entries(fresh)) expect(read(name), `${name} is stale — run bun run build in site/`).toBe(text);
});

test('every README section reaches the reference page; every cross-page anchor exists', () => {
	for (const s of readSections(readme)) expect(reference).toContain(`id="${s.slug}"`);
	for (const [, hash] of index.matchAll(/href="\/#([\w-]+)"/g)) expect(index).toContain(`id="${hash}"`);
});

test('head metadata is complete and consistent with the model', () => {
	const desc = /<meta name="description" content="([^"]*)"/.exec(index)?.[1] ?? '';
	expect(desc.length).toBeLessThanOrEqual(160);
	expect(desc.endsWith('.')).toBe(true);
	expect(index).toContain(`<link rel="canonical" href="${url('/')}">`);
	expect(url('/')).toBe('https://graphx.sh/');
	expect(index).not.toContain('index.html');
	for (const t of ['og:title', 'og:description', 'og:url', 'og:type', 'og:site_name', 'og:image:width', 'og:image:height', 'og:image:type', 'og:image:alt']) expect(index).toContain(`property="${t}"`);
	expect(index).toContain(`content="${url('/og.png')}"`);
	expect(index).toContain('name="twitter:card" content="summary_large_image"');
	const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(index)?.[1] ?? '');
	return readVersion().then((v) => {
		expect(ld.name).toBe(page.name);
		expect(ld.softwareVersion).toBe(v);
	});
});

test('every capability has an id, an h2, 1–3 sentences and inline code', () => {
	expect(capabilities.length).toBeGreaterThanOrEqual(4);
	expect(index.match(/<h1/g)?.length).toBe(1);
	for (const c of capabilities) {
		expect(index).toContain(`<section class="section" id="${c.id}" aria-labelledby="${c.id}-title">`);
		expect(c.title.split(/\s+/).length).toBeLessThanOrEqual(6);
		expect(c.title.endsWith('.')).toBe(false);
		expect(c.body.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(3);
		expect(c.body).toMatch(/`[^`]+`/);
	}
	expect(page.h1.split(/\s+/).length).toBeLessThanOrEqual(8);
});

test('agent files exist and the sitemap names only built files', () => {
	for (const f of ['llms.txt', 'AGENTS.md', 'sitemap.xml', 'robots.txt', 'index.md', 'og.png', 'favicon.svg']) expect(existsSync(pub(f)), f).toBe(true);
	expect(read('robots.txt')).toContain('Sitemap: https://graphx.sh/sitemap.xml');
	for (const [, loc] of read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)) {
		const p = new URL(loc as string).pathname;
		expect(existsSync(pub(p === '/' ? 'index.html' : `${p.slice(1)}.html`)), loc).toBe(true);
	}
	expect(read('AGENTS.md')).toContain('\\|');
});

test('og.png header says 1200x630 and stays small', () => {
	const buf = readFileSync(pub('og.png'));
	expect(buf.readUInt32BE(16)).toBe(1200);
	expect(buf.readUInt32BE(20)).toBe(630);
	expect(statSync(pub('og.png')).size).toBeLessThan(300_000);
});

test('project links: header icons github, x, linkedin in order and outside the collapsing nav; footer adds discord', () => {
	const header = /<header[\s\S]*?<\/header>/.exec(index)?.[0] ?? '';
	const footer = /<footer[\s\S]*?<\/footer>/.exec(index)?.[0] ?? '';
	const icons = (html: string) => [...html.matchAll(/<a href="([^"]+)" rel="me noopener"><svg[\s\S]*?<span class="sr">([^<]+)<\/span>/g)].map((m) => m[2]);
	const headerIcons = links.filter((l) => l.where.includes('header')).map((l) => l.label);
	expect(icons(header)).toEqual(headerIcons);
	expect(headerIcons.map((l) => l.split(' ').pop())).toEqual(['GitHub', 'X', 'LinkedIn']);
	expect(header.indexOf('class="icons"')).toBeGreaterThan(header.indexOf('</details>'));
	expect(icons(footer).length).toBe(4);
	expect(footer).toContain('https://www.linkedin.com/in/tim-mikeladze');
	expect(footer).toContain('https://x.com/linesofcode');
	expect(footer).toContain('https://discord.com/users/linesofcode');
	expect(header).toContain(repo);
	expect(boundaries.holds.length + boundaries.judgements.length + boundaries.missing.length).toBeGreaterThan(6);
});
