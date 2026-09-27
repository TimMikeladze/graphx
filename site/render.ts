/**
 * The renderer: resolves the content model against the README and emits every artefact — both pages,
 * llms.txt, AGENTS.md, per-page Markdown, sitemap.xml, robots.txt and the favicon. It has no copy;
 * the words are in content.ts and the examples are in the README.
 */
import bash from '@shikijs/langs/bash';
import json from '@shikijs/langs/json';
import sql from '@shikijs/langs/sql';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import vitesseDark from '@shikijs/themes/vitesse-dark';
import vitesseLight from '@shikijs/themes/vitesse-light';
import { Marked } from 'marked';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import {
	agents,
	audience,
	boundaries,
	buildToday,
	capabilities,
	type Capability,
	ecosystem,
	figures,
	footerColumns,
	guides,
	links,
	npm,
	origin,
	page,
	principles,
	reference,
	repo,
	showcase,
	split,
	start,
	url,
} from './content.ts';
import { brandIcon, ecoIcon, FAVICON_SVG, glyph, productMark, type BrandName } from './icons.ts';
import {
	type Block,
	countFigure,
	fencedBlocks,
	readInstall,
	readReadme,
	readSections,
	readTable,
	readVersion,
	referenceBody,
	resolve,
	slugify,
} from './readme.ts';
import { bootScript, css, uiScript } from './styles.ts';

const LANGS: Record<string, string> = { sh: 'bash', bash: 'bash', ts: 'typescript', typescript: 'typescript', tsx: 'tsx', json: 'json', sql: 'sql' };

export function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function makeHighlighter() {
	return createHighlighterCore({
		themes: [vitesseDark, vitesseLight],
		langs: [typescript, tsx, bash, json, sql],
		// Oniguruma (WASM), not the JavaScript engine: the JS engine compiles grammars to the host's
		// RegExp and, when forgiving, skips what it cannot compile — so the highlighting, and with it
		// the committed output, changed with the Bun version. WASM depends only on the lockfile.
		engine: createOnigurumaEngine(import('shiki/wasm')),
	});
}
type Highlighter = Awaited<ReturnType<typeof makeHighlighter>>;

function highlight(hl: Highlighter, code: string, lang: string): string {
	const resolved = LANGS[lang];
	if (!resolved) return `<pre class="plain"><code>${escapeHtml(code)}</code></pre>`;
	return hl.codeToHtml(code, { lang: resolved, themes: { light: 'vitesse-light', dark: 'vitesse-dark' }, defaultColor: false });
}

/** Markdown → HTML. Raw HTML in the source is escaped, never emitted; code is highlighted at build time. */
export function markdownRenderer(hl: Highlighter) {
	return new Marked({
		gfm: true,
		renderer: {
			html: ({ text }) => escapeHtml(text),
			code: ({ text, lang }) => highlight(hl, text, lang ?? ''),
			heading({ text, depth, tokens }) {
				const id = slugify(text);
				return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to ${escapeHtml(text)}">#</a>${this.parser.parseInline(tokens)}</h${depth}>`;
			},
			table(token) {
				const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
				const rows = token.rows
					.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`)
					.join('');
				return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
			},
		},
	});
}

interface Model {
	readme: string;
	version: string;
	install: string;
	blocks: Block[];
	hl: Highlighter;
	md: Marked;
	/** Each figure's count, in `figures` order. */
	counts: number[];
}

async function buildModel(): Promise<Model> {
	const readme = await readReadme();
	const hl = await makeHighlighter();
	const counts = await Promise.all(figures.map((f) => countFigure(readme, f.source)));
	return { readme, version: await readVersion(), install: readInstall(readme), blocks: fencedBlocks(readme), hl, md: markdownRenderer(hl), counts };
}

const inline = (m: Model, text: string): string => m.md.parseInline(text) as string;

function linkHref(href: string): string {
	return href === 'repo' ? repo : href;
}

const BRAND_ICONS = new Set<string>(['github', 'x', 'linkedin', 'discord']);

function iconLinks(where: 'header' | 'footer'): string {
	return links
		.filter((l) => l.where.includes(where) && BRAND_ICONS.has(l.icon))
		.map(
			(l) =>
				`<a href="${escapeHtml(linkHref(l.href))}" rel="me noopener">${brandIcon(l.icon as BrandName)}<span class="sr">${escapeHtml(l.label)}</span></a>`,
		)
		.join('');
}

const NAV = [
	{ label: 'Home', href: '/' },
	{ label: 'Reference', href: '/reference' },
	{ label: 'Guides', href: '/#guides' },
	{ label: 'Boundaries', href: '/#boundaries' },
	{ label: 'Start', href: '/#start' },
	{ label: 'npm', href: npm, external: true },
];

function header(current: '/' | '/reference'): string {
	const items = NAV.map((n) => {
		const cur = n.href === current ? ' aria-current="page"' : '';
		const ext = n.external ? ' class="ext" rel="noopener"' : '';
		return `<a href="${n.href}"${cur}${ext}>${n.label}</a>`;
	}).join('');
	const themeIcons = glyph('monitor', 18, 'i-system') + glyph('moon', 18, 'i-dark') + glyph('sun', 18, 'i-light');
	return `<header class="header">
<div class="shell">
<a class="brand" href="/">${page.name}</a>
<nav class="nav" aria-label="Primary">${items}</nav>
<details class="nav-more"><summary>Menu</summary><div class="menu">${items}</div></details>
<div class="icons">${iconLinks('header')}<button class="theme" type="button" aria-label="Theme: system. Click to change">${themeIcons}</button></div>
</div>
</header>`;
}

const isLocal = (href: string) => href.startsWith('/');

/** Segmented switch driving the same localStorage key as the header toggle. */
function themeSwitch(): string {
	const btn = (mode: string, icon: 'monitor' | 'sun' | 'moon', name: string) =>
		`<button type="button" data-set-theme="${mode}" aria-label="${name} theme" aria-pressed="false">${glyph(icon, 14)}</button>`;
	return `<div class="seg" role="group" aria-label="Theme">${btn('system', 'monitor', 'System')}${btn('light', 'sun', 'Light')}${btn('dark', 'moon', 'Dark')}</div>`;
}

function footer(): string {
	const textLinks = links.filter((l) => l.where.includes('footer') && l.icon === 'text');
	const cols = footerColumns
		.map(
			(c) =>
				`<div><h2>${escapeHtml(c.title)}</h2><ul>${c.links
					.map(
						(l) =>
							`<li><a href="${escapeHtml(l.href)}"${isLocal(l.href) ? '' : ' class="ext" rel="noopener"'}>${escapeHtml(l.label)}</a>${l.isNew ? ' <span class="new">New</span>' : ''}</li>`,
					)
					.join('')}</ul></div>`,
		)
		.join('');
	const community = `<div><h2>Community</h2><ul>${[
		['X', links.find((l) => l.icon === 'x')?.href],
		['GitHub', repo],
		['LinkedIn', links.find((l) => l.icon === 'linkedin')?.href],
		['Discord', links.find((l) => l.icon === 'discord')?.href],
		...textLinks.map((l) => [l.label, linkHref(l.href)]),
	]
		.map(([label, href]) => `<li><a href="${escapeHtml(href ?? '')}" class="ext" rel="noopener">${escapeHtml(label ?? '')}</a></li>`)
		.join('')}</ul><div class="ficons">${iconLinks('footer')}</div></div>`;
	return `<footer class="footer">
<div class="shell">
<p class="credit">${page.credit}</p>
<div class="fcols">${cols}${community}</div>
<div class="fbottom"><span class="fmark">${productMark(20)}</span><p class="copy">© ${page.year} linesofcode</p>${themeSwitch()}</div>
</div>
</footer>`;
}

function head(m: Model, opts: { title: string; description: string; path: string; jsonld?: object }): string {
	const canonical = url(opts.path);
	const image = url('/og.png');
	const alt = `${page.name} — ${page.h1.toLowerCase()}`;
	const t = escapeHtml(opts.title);
	const d = escapeHtml(opts.description);
	const favicon = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;
	return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${canonical}">
<script>${bootScript}</script>
<meta name="theme-color" content="#101010" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fcfcfc" media="(prefers-color-scheme: light)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${page.name}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="${escapeHtml(alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${image}">
<link rel="icon" href="${favicon}">
<link rel="alternate" type="text/markdown" href="${opts.path === '/' ? '/index.md' : `${opts.path}.md`}">
${opts.jsonld ? `<script type="application/ld+json">${JSON.stringify(opts.jsonld)}</script>` : ''}
<style>${css}</style>`;
}

function shell(m: Model, opts: { title: string; description: string; path: '/' | '/reference'; body: string; jsonld?: object }): string {
	return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
${head(m, opts)}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header(opts.path)}
<main id="main">
${opts.body}
</main>
${footer()}
<script>${uiScript}</script>
</body>
</html>
`;
}

/* ---------- demos ---------- */

function demoFrame(m: Model, ref: Parameters<typeof resolve>[1]): string {
	const r = resolve(m.blocks, ref);
	if (r.terminal) {
		return `<figure class="demo terminal"><figcaption class="bar"><span class="cmd">${escapeHtml(r.title)}</span><span class="chip">captured output</span></figcaption><pre><code>${escapeHtml(r.code)}</code></pre></figure>`;
	}
	return `<figure class="demo"><figcaption class="bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${escapeHtml(r.title)}</span></figcaption>${highlight(m.hl, r.code, r.lang)}</figure>`;
}

function renderDemo(m: Model, cap: Capability): string {
	const d = cap.demo;
	if (d.kind === 'code') return demoFrame(m, d.ref);
	if (d.kind === 'variants') {
		return `<div class="variants">${d.items
			.map((i) => `<div class="variant">${demoFrame(m, i.ref)}<p class="caption">${escapeHtml(i.caption)}</p></div>`)
			.join('')}</div>`;
	}
	const t = readTable(m.readme, d.header);
	return `<div class="table-wrap"><table><thead><tr>${t.header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${t.rows
		.map((r) => `<tr>${r.map((c) => `<td>${inline(m, c)}</td>`).join('')}</tr>`)
		.join('')}</tbody></table></div>`;
}

function section(m: Model, cap: Capability): string {
	return `<section class="section" id="${cap.id}" aria-labelledby="${cap.id}-title">
<div class="shell${cap.demo.kind === 'code' ? ' cap-split' : ''}">
<div class="cap-text">
<h2 id="${cap.id}-title">${escapeHtml(cap.title)}</h2>
<p class="prose">${inline(m, cap.body)}</p>
${cap.aside ? `<p class="aside">${inline(m, cap.aside)}</p>` : ''}
</div>
${renderDemo(m, cap)}
</div>
</section>`;
}

function copyButton(text: string, name: string): string {
	return `<button class="copy-btn" type="button" data-copy="${escapeHtml(text)}">${glyph('copy', 15)}<span class="sr" data-say>${escapeHtml(name)}</span></button>`;
}

function pill(command: string, name: string, extra = ''): string {
	return `<div class="pill${extra}"><span class="dollar" aria-hidden="true">$</span><code>${escapeHtml(command)}</code>${copyButton(command, name)}</div>`;
}

function hero(m: Model): string {
	return `<section class="hero" aria-labelledby="title">
<div class="shell">
${productMark(46)}
<h1 id="title">${escapeHtml(page.h1)}</h1>
<p class="lede">${inline(m, page.lede)}</p>
<div class="audience">
<input type="radio" name="audience" id="aud-humans" class="sr" checked>
<input type="radio" name="audience" id="aud-agents" class="sr">
<div class="aud-tabs"><label for="aud-humans">For humans</label><span aria-hidden="true"></span><label for="aud-agents">For agents</label></div>
<div class="aud-panel aud-humans">${pill(m.install, 'Copy install command')}</div>
<div class="aud-panel aud-agents">${pill(audience.agents, 'Copy agent command')}
<p class="aud-links"><a href="/llms.txt">${glyph('file', 14)}llms.txt</a><a href="/AGENTS.md">${glyph('file', 14)}AGENTS.md</a><button type="button" data-copy-md="/index.md">${glyph('copy', 14)}<span data-say>Copy page as Markdown</span></button></p></div>
</div>
<p class="version">Currently v${escapeHtml(m.version)}</p>
</div>
</section>`;
}

function splitDemo(m: Model): string {
	const input = resolve(m.blocks, split.input.ref);
	const handler = resolve(m.blocks, split.handler.ref);
	return `<section class="split-wrap" aria-label="From scaffold to schema">
<div class="split">
<figure class="demo sframe"><figcaption class="bar">${glyph('terminal', 14)}<span>${escapeHtml(split.input.label)}</span></figcaption>
<pre class="term"><code><span class="prompt">~ </span><span class="typed">${escapeHtml(input.title.slice(2))}</span>
${escapeHtml(input.code)}</code></pre></figure>
<figure class="demo sframe"><figcaption class="bar">${glyph('file', 14)}<span>${escapeHtml(split.handler.label)}</span></figcaption>${highlight(m.hl, handler.code, handler.lang)}</figure>
</div>
</section>`;
}

function figuresRow(m: Model): string {
	return `<section class="figures" aria-label="Counted from the repository">
<div class="shell"><dl>${figures
		.map((f, i) => `<div><dt>${escapeHtml(f.label)}</dt><dd>${m.counts[i]}</dd></div>`)
		.join('')}</dl></div>
</section>`;
}

function ecosystemBand(m: Model): string {
	return `<section class="section eco" id="ecosystem" aria-labelledby="ecosystem-title">
<div class="shell">
<h2 id="ecosystem-title">${escapeHtml(ecosystem.title)}</h2>
<p class="eco-lede">${inline(m, ecosystem.lede)}</p>
<ul class="eco-marks">${ecosystem.marks
		.map((e) => `<li><a href="${e.href}" rel="noopener" title="${escapeHtml(e.label)}">${ecoIcon(e.name)}<span class="sr">${escapeHtml(e.label)}</span></a></li>`)
		.join('')}</ul>
</div>
</section>`;
}

function principlesStrip(m: Model): string {
	return `<section class="principles" aria-label="Principles">
<div class="shell"><ul>${principles
		.map((p) => `<li><h3>${escapeHtml(p.title)}</h3><p>${inline(m, p.body)}</p></li>`)
		.join('')}</ul></div>
</section>`;
}

function showcaseSection(m: Model): string {
	const tabs = showcase.tabs.map((t, i) => ({ ...t, id: `tab-${t.label.toLowerCase()}`, r: resolve(m.blocks, t.ref), i }));
	return `<section class="section showcase" id="showcase" aria-labelledby="showcase-title">
<div class="shell sc-grid">
<div class="sc-copy">
<h2 id="showcase-title">${escapeHtml(showcase.title)}</h2>
<p class="prose">${inline(m, showcase.body)}</p>
<a class="control control--solid pill-btn" href="/reference">${glyph('book')}Visit Documentation</a>
<p class="supports-cap">Supports</p>
<div class="supports"><ul>${showcase.supports
		.map((n) => {
			const e = ecosystem.marks.find((x) => x.name === n);
			return `<li title="${escapeHtml(e?.label ?? n)}">${ecoIcon(n, 20)}<span class="sr">${escapeHtml(e?.label ?? n)}</span></li>`;
		})
		.join('')}</ul><span>${escapeHtml(showcase.more)}</span></div>
</div>
<div class="sc-tabs">
${tabs.map((t) => `<input type="radio" name="showcase" id="${t.id}" class="sr"${t.i === 0 ? ' checked' : ''}>`).join('')}
<div class="tabrow">${tabs.map((t) => `<label for="${t.id}">${escapeHtml(t.label)}</label>`).join('')}</div>
${tabs
	.map(
		(t) =>
			`<figure class="demo sc-frame sc-${t.i}"><figcaption class="bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="fname">${escapeHtml(t.r.title)}</span>${copyButton(t.r.code, `Copy ${t.r.title}`)}</figcaption><div class="sc-body">${highlight(m.hl, t.r.code, t.r.lang)}</div></figure>`,
	)
	.join('\n')}
<div class="pager" aria-hidden="true">${tabs.map((t) => `<label for="${t.id}"></label>`).join('')}</div>
</div>
</div>
</section>`;
}

function buildTodayBand(): string {
	const cmd = buildToday.scaffold.kind === 'terminal' ? buildToday.scaffold.command : '';
	return `<section class="today" aria-labelledby="today-title">
<div class="shell today-row">
<h2 id="today-title">${escapeHtml(buildToday.title)}</h2>
<div class="today-actions"><a class="control control--solid pill-btn" href="/reference">${glyph('book')}Documentation</a>${pill(cmd, 'Copy scaffold command', ' pill--outline')}</div>
</div>
</section>`;
}

function guidesSection(m: Model): string {
	return `<section class="section" id="guides" aria-labelledby="guides-title">
<div class="shell">
<h2 id="guides-title">Guides</h2>
<ul class="guides">${guides
		.map((g) => {
			const r = resolve(m.blocks, g.ref);
			return `<li><a class="guide" href="${g.href}"><h3>${escapeHtml(g.title)}</h3><p>${escapeHtml(g.body)}</p><div class="tilt" aria-hidden="true">${highlight(m.hl, r.code, r.lang)}</div></a></li>`;
		})
		.join('')}</ul>
</div>
</section>`;
}

function boundariesSection(m: Model): string {
	const col = (k: 'holds' | 'judgements' | 'missing') =>
		`<div class="${k}"><h3>${boundaries.titles[k]} <span class="count">${boundaries[k].length}</span></h3><ul>${boundaries[k].map((i) => `<li>${inline(m, i)}</li>`).join('')}</ul></div>`;
	return `<section class="section" id="boundaries" aria-labelledby="boundaries-title">
<div class="shell">
<h2 id="boundaries-title">${boundaries.title}</h2>
<p class="prose">${inline(m, boundaries.intro)}</p>
<div class="cols">${col('holds')}${col('judgements')}${col('missing')}</div>
</div>
</section>`;
}

function startSection(m: Model): string {
	return `<section class="section" id="start" aria-labelledby="start-title">
<div class="shell">
<h2 id="start-title">${start.title}</h2>
<p class="prose">${inline(m, start.body)}</p>
<div class="start-grid">${demoFrame(m, start.install)}${demoFrame(m, start.gate)}</div>
</div>
</section>`;
}

function jsonLd(m: Model, path: string) {
	return {
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: page.name,
		description: page.description,
		url: url(path),
		applicationCategory: page.category,
		softwareVersion: m.version,
		offers: { '@type': 'Offer', price: '0' },
		license: 'https://opensource.org/licenses/MIT',
		codeRepository: repo,
	};
}

function landing(m: Model): string {
	const body = [
		hero(m),
		splitDemo(m),
		figuresRow(m),
		ecosystemBand(m),
		principlesStrip(m),
		showcaseSection(m),
		...capabilities.map((c) => section(m, c)),
		boundariesSection(m),
		startSection(m),
		guidesSection(m),
		buildTodayBand(),
	].join('\n');
	return shell(m, {
		title: `${page.name} — ${page.tagline}`,
		description: page.description,
		path: '/',
		body,
		jsonld: jsonLd(m, '/'),
	});
}

function referencePage(m: Model): string {
	const sections = readSections(m.readme);
	const toc = `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${sections
		.map((s) => `<li><a href="#${s.slug}">${escapeHtml(s.text)}</a></li>`)
		.join('')}</ul></nav>`;
	const body = `<div class="shell ref">${toc}<article class="reference"><h1>${reference.title}</h1><p>${inline(m, reference.intro)}</p>${m.md.parse(referenceBody(m.readme))}</article></div>`;
	return shell(m, {
		title: `${reference.title} — ${page.name}`,
		description: reference.description,
		path: '/reference',
		body,
		jsonld: jsonLd(m, '/reference'),
	});
}

/* ---------- Markdown surfaces ---------- */

function fenceFor(m: Model, ref: Parameters<typeof resolve>[1]): string {
	const r = resolve(m.blocks, ref);
	const text = r.terminal ? `${r.title}\n${r.code}` : r.code;
	return `\`\`\`${r.terminal ? 'sh' : r.lang}\n${text}\n\`\`\``;
}

function capabilityMd(m: Model, cap: Capability): string {
	const d = cap.demo;
	let demo: string;
	if (d.kind === 'code') demo = fenceFor(m, d.ref);
	else if (d.kind === 'variants') demo = d.items.map((i) => `**${i.caption}**\n\n${fenceFor(m, i.ref)}`).join('\n\n');
	else {
		const t = readTable(m.readme, d.header);
		demo = [`| ${t.header.join(' | ')} |`, `| ${t.header.map(() => '---').join(' | ')} |`, ...t.rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
	}
	return `## ${cap.title}\n\n${cap.body}\n\n${demo}${cap.aside ? `\n\n${cap.aside}` : ''}`;
}

function boundariesMd(): string {
	const list = (k: 'holds' | 'judgements' | 'missing') => `### ${boundaries.titles[k]} (${boundaries[k].length})\n\n${boundaries[k].map((i) => `- ${i}`).join('\n')}`;
	return `## ${boundaries.title}\n\n${boundaries.intro}\n\n${list('holds')}\n\n${list('judgements')}\n\n${list('missing')}`;
}

function indexMd(m: Model): string {
	return `# ${page.name} — ${page.h1}

${page.lede}

Currently v${m.version}. Install: \`${m.install}\`

${figures.map((f, i) => `- **${m.counts[i]}** ${f.label.toLowerCase()}`).join('\n')}

## Principles

${principles.map((p) => `- **${p.title}.** ${p.body}`).join('\n')}

## ${showcase.title}

${showcase.body}

${showcase.tabs.map((t) => `**${t.label}**\n\n${fenceFor(m, t.ref)}`).join('\n\n')}

${capabilities.map((c) => capabilityMd(m, c)).join('\n\n')}

${boundariesMd()}

## ${start.title}

${start.body}

${fenceFor(m, start.install)}

${fenceFor(m, start.gate)}

## Guides

${guides.map((g) => `- [${g.title}](${url(g.href.split('#')[0] ?? '/')}#${g.href.split('#')[1]}): ${g.body}`).join('\n')}

## Links

- [Reference](${url('/reference')})
- [GitHub](${repo})
- [npm](${npm})
`;
}

function llmsTxt(m: Model): string {
	return `# ${page.name}

> ${page.description}

${page.lede}

${capabilities.map((c) => capabilityMd(m, c)).join('\n\n')}

## Links

- [Reference](${url('/reference')}): the full documentation
- [Repository](${repo})
- [AGENTS.md](${url('/AGENTS.md')}): how an agent should use graphx
`;
}

function agentsMd(m: Model): string {
	return `# AGENTS.md — using ${page.name}

${agents.summary}

## Install

\`\`\`sh
${m.install}
\`\`\`

## Minimal working snippet

${agents.minimal.map((r) => fenceFor(m, r)).join('\n\n')}

## Options that matter

| Option | Where | Effect |
| --- | --- | --- |
${agents.options.map((o) => o.map((c) => c.replace(/\|/g, '\\|'))).map((o) => `| \`${o[0]}\` | ${o[1]} | ${o[2]} |`).join('\n')}

## Three mistakes that break it

${agents.mistakes.map((x, i) => `${i + 1}. ${x}`).join('\n')}

## More

- [Reference](${url('/reference')})
- [llms.txt](${url('/llms.txt')})
- [Repository](${repo})
`;
}

export const SITEMAP_PATHS = ['/', '/reference'];

function sitemap(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SITEMAP_PATHS.map((p) => `<url><loc>${url(p)}</loc></url>`).join('\n')}
</urlset>
`;
}

function robots(): string {
	return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

/** Every text artefact, keyed by its path under the site's public directory. og.png is drawn by card.ts. */
export async function renderSite(): Promise<Record<string, string>> {
	const m = await buildModel();
	return {
		'index.html': landing(m),
		'reference.html': referencePage(m),
		'index.md': indexMd(m),
		'reference.md': `# ${reference.title}\n\n${referenceBody(m.readme)}`,
		'llms.txt': llmsTxt(m),
		'AGENTS.md': agentsMd(m),
		'sitemap.xml': sitemap(),
		'robots.txt': robots(),
		'favicon.svg': FAVICON_SVG,
	};
}

/** Exposed for the tests. */
export { buildModel, markdownRenderer as renderMarkdownWith, makeHighlighter };
