import { readFile } from 'node:fs/promises';
import path from 'node:path';
import bash from '@shikijs/langs/bash';
import json from '@shikijs/langs/json';
import sql from '@shikijs/langs/sql';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import vitesseDark from '@shikijs/themes/vitesse-dark';
import vitesseLight from '@shikijs/themes/vitesse-light';
import { Marked } from 'marked';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * The whole page is rendered here, at build time, from the repo's README. The
 * browser gets static markup and never downloads a markdown parser or a syntax
 * highlighter; `src/main.ts` only wires up the parts that need a browser.
 *
 * The README is the single source of truth: the hero title, tagline and install
 * command, the section rail, the on-page docs and /llms.txt all come out of it.
 * Edit README.md and the next build carries the change onto the page.
 */

const REPO = 'https://github.com/TimMikeladze/graphx';
const NPM = 'https://www.npmjs.com/package/graphx';

/**
 * The three claims that decide whether a visitor keeps reading. Each is a
 * property of the design rather than a feature-list entry, and each is stated
 * somewhere in the README — keep them in step when that changes.
 */
const PILLARS = [
	{
		title: 'One schema, no codegen',
		body: 'Nodes and edges are Zod objects. Typed mutations, pattern matching, HTTP routes, the OpenAPI contract, React Query hooks and MCP tools are all inferred from that one <code>Schema</code> type — there is no generate step to run and nothing to keep in sync.',
	},
	{
		title: 'Every write is bitemporal',
		body: 'Versions carry <code>valid_from</code> / <code>valid_to</code>, so history is append-only and nothing is erased — a delete closes a version. An <code>asOf</code> read reconstructs the graph exactly as it stood at any instant.',
	},
	{
		title: 'Three backends, one contract',
		body: 'libSQL/SQLite, Postgres with pgvector, or DuckDB over an object store. The backend is a configuration choice; every public type, method, HTTP route and JSON payload is identical across all three.',
	},
] as const;

/**
 * The hero card. Three tabs over the same story — define the graph, query it,
 * serve it — because that is the whole arc of using this library and it fits in
 * about a dozen lines each. All three are lifted from the README so the card
 * cannot drift from the docs below it.
 */
const PANELS = [
	{
		label: 'Define',
		lang: 'typescript',
		code: `import { defineGraphSchema, hashEmbed } from 'graphx';
import { z } from 'zod';

export const schema = defineGraphSchema({
  nodes: {
    site: z.object({ name: z.string(), region: z.enum(['us', 'eu']) }),
    gateway: z.object({ name: z.string(), firmware: z.string() }),
  },
  edges: {
    deployedAt: { from: 'gateway', to: 'site', single: true },
  },
});`,
	},
	{
		label: 'Query',
		lang: 'typescript',
		code: `// GraphRAG: vector seeds, then a time-respecting walk out from them
await g.retrieve({ query: 'overheating sensor', k: 10, maxDepth: 2 });

// Pattern match — rows typed per alias, no codegen
const q = await match(schema, db)
  .node('d', 'device').in('raised').node('a', 'alert')
  .select('d', 'a');
const rows = await q.run(); // rows[0].d.data, rows[0].a.data

// Time travel: every version of a node, and what moved between two instants
await history(db, id);
await diff(db, t1, t2);`,
	},
	{
		label: 'Serve',
		lang: 'typescript',
		code: `import { createApp, hashEmbed } from 'graphx';
import { schema } from './schema.ts';

const { app } = await createApp({
  schema,
  embedder: hashEmbed(), // every write embeds through it; no dimension to configure
  db: 'iot_demo',
  openapi: { title: 'iot-fleet' },
});

// Typed routes + GET /openapi.json + an interactive reference at /docs
Bun.serve({ port: 8899, fetch: app.fetch });`,
	},
] as const;

/**
 * shiki loads grammars by their canonical name; README fences use the short
 * forms. Anything unlisted falls back to plain text rather than throwing.
 */
const LANG_ALIASES: Record<string, string> = {
	sh: 'bash',
	shell: 'bash',
	bash: 'bash',
	ts: 'typescript',
	typescript: 'typescript',
	tsx: 'tsx',
	js: 'typescript',
	json: 'json',
	sql: 'sql',
};

/**
 * Title, tagline and install command, read out of the README so the hero has no
 * copy of its own to keep current.
 *
 * The tagline is the first prose paragraph under the `#` heading — the README
 * hard-wraps it across several lines, so the whole paragraph is joined back up.
 * Lines that open with `[` are the site link and badge rows, not prose.
 */
function readHero(md: string) {
	const title = /^#\s+(.+)$/m.exec(md)?.[1] ?? 'graphx';

	const lines = md.split(/\r?\n/).slice(1);
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

	const pkg = /```(?:sh|bash)\nbun add ([^\n]+)\n```/.exec(md)?.[1] ?? 'graphx';
	return {
		title,
		tagline: paragraph.join(' '),
		install: {
			bun: `bun add ${pkg}`,
			npm: `npm install ${pkg}`,
			pnpm: `pnpm add ${pkg}`,
		},
	};
}

/**
 * Drop the leading title and tagline — the hero already carries both — and
 * point repo-relative links at GitHub so they resolve off-repo.
 */
function prepareBody(md: string) {
	const firstSection = md.indexOf('\n## ');
	const body = firstSection === -1 ? md : md.slice(firstSection + 1);
	return body.replace(/\]\(\.\/([^)]+)\)/g, `](${REPO}/blob/main/$1)`);
}

/** GitHub's heading slug algorithm, so links written in the README resolve. */
function slugify(text: string) {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\- ]+/g, '')
		.replace(/ /g, '-');
}

/** Every `##` section, in README order — the rail and llms.txt both use it. */
function sections(md: string) {
	return [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => {
		const text = (m[1] ?? '').trim();
		return { text, slug: slugify(text) };
	});
}

/**
 * The intro prose sitting directly under each `##`, before any `###`. Used as
 * the llms.txt descriptions, so they stay in step with the docs.
 */
function sectionIntros(md: string) {
	const lines = md.split(/\r?\n/);
	const marks: { line: number; slug: string }[] = [];
	lines.forEach((line, i) => {
		if (line.startsWith('## ')) {
			marks.push({ line: i, slug: slugify(line.slice(3).trim()) });
		}
	});

	const intros = new Map<string, string>();
	marks.forEach(({ line, slug }, i) => {
		const end = marks[i + 1]?.line ?? lines.length;
		const paragraphs: string[] = [];
		let inFence = false;
		for (const raw of lines.slice(line + 1, end)) {
			const s = raw.trim();
			if (s.startsWith('```')) {
				inFence = !inFence;
				continue;
			}
			if (inFence) continue;
			if (s.startsWith('###')) break;
			if (!s) continue;
			// Stop at the first table, list or quote rather than skipping it: the
			// lines that follow are wrapped continuations of that block, and
			// splicing them into a sentence reads as nonsense.
			if (/^[|\-*>]/.test(s)) break;
			paragraphs.push(s);
			if (paragraphs.join(' ').length > 200) break;
		}
		const intro = summarise(paragraphs.join(' '));
		if (intro) intros.set(slug, intro);
	});
	return intros;
}

/** First sentence or two of a paragraph, flattened to plain text. */
function summarise(text: string) {
	const plain = text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their label
		.replace(/\*\*([^*]+)\*\*/g, '$1') // bold only; bare _ and * are identifiers
		.replace(/`/g, '')
		.trim();
	if (!plain) return '';

	// Split only where a terminator is followed by a capital, so "Node.js" and
	// "graphx.config.ts" survive intact.
	const sentences = plain.split(/(?<=[.!?])\s+(?=[A-Z])/);
	let out = '';
	for (const sentence of sentences) {
		out = out ? `${out} ${sentence}` : sentence;
		if (out.length >= 60) break;
	}
	out = out.trim().replace(/:$/, '.');
	if (out.length <= 165) return out;
	const cut = out.slice(0, 165);
	return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '')}…`;
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export interface RenderedPage {
	html: string;
	title: string;
	description: string;
}

async function readReadme(siteDir: string) {
	return readFile(path.join(path.resolve(siteDir, '..'), 'README.md'), 'utf8');
}

/**
 * llms.txt (see llmstxt.org): a plain-text map of the docs for agents to read
 * instead of scraping the rendered page. Built from the same README sections as
 * the rail, so the two cannot disagree.
 */
export async function renderLlmsTxt(siteDir: string): Promise<string> {
	const readme = await readReadme(siteDir);
	const { title, tagline } = readHero(readme);
	const intros = sectionIntros(readme);
	const list = sections(readme)
		.map(({ text, slug }) => {
			const intro = intros.get(slug);
			return `- [${text}](${REPO}/blob/main/README.md#${slug})${intro ? `: ${intro}` : ''}`;
		})
		.join('\n');

	return `# ${title}

> ${tagline}

## Docs

${list}

## Links

- [Full README](${REPO}/blob/main/README.md)
- [GitHub](${REPO})
- [npm](${NPM})
`;
}

/** Renders the whole page to static HTML. Nothing here ships to the browser. */
export async function renderPage(siteDir: string): Promise<RenderedPage> {
	const readme = await readReadme(siteDir);

	const highlighter = await createHighlighterCore({
		themes: [vitesseDark, vitesseLight],
		langs: [typescript, tsx, bash, json, sql],
		engine: createJavaScriptRegexEngine({ forgiving: true }),
	});

	const highlight = (code: string, lang: string) =>
		highlighter.codeToHtml(code, {
			lang,
			themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
			defaultColor: false,
		});

	const marked = new Marked({
		gfm: true,
		renderer: {
			code({ text, lang }) {
				const resolved = (lang && LANG_ALIASES[lang]) ?? 'text';
				// Window chrome: language tag on the left, copy on the right.
				return `<figure class="code-block">
					<figcaption class="code-bar">
						<span class="code-lang">${escapeHtml(resolved)}</span>
						<button class="code-copy" type="button">Copy</button>
					</figcaption>
					${highlight(text, resolved)}
				</figure>`;
			},
			heading({ text, depth, tokens }) {
				const id = slugify(text);
				const inner = this.parser.parseInline(tokens);
				return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to ${escapeHtml(text)}">#</a>${inner}</h${depth}>`;
			},
		},
	});

	const { title, tagline, install } = readHero(readme);

	// Wide API tables scroll on their own instead of blowing out the page.
	const body = (marked.parse(prepareBody(readme)) as string)
		.replace(/<table>/g, '<div class="table-wrap"><table>')
		.replace(/<\/table>/g, '</table></div>');

	const rail = sections(readme)
		.map(
			({ text, slug }) => `<li><a href="#${slug}" data-spy="${slug}">${escapeHtml(text)}</a></li>`,
		)
		.join('');

	const html = `<a class="skip" href="#content">Skip to content</a>
	<header class="nav">
		<div class="nav-inner">
			<a class="brand" href="#top">
				<!-- A closed triad: three nodes, three edges. The smallest drawing
				     that is unmistakably a graph rather than a shape — an earlier
				     one-node-to-two arrangement read as a share icon. -->
				<svg class="brand-mark" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
					<path d="M3.4 10.8 9 3.6l3.6 8Z" />
					<circle cx="3.4" cy="10.8" r="2.1" fill="currentColor" stroke="none" />
					<circle cx="9" cy="3.6" r="1.6" fill="currentColor" stroke="none" />
					<circle cx="12.6" cy="11.6" r="1.6" fill="currentColor" stroke="none" />
				</svg>
				<span class="brand-name">${escapeHtml(title)}</span>
			</a>
			<nav class="nav-links">
				<a href="#quickstart">Docs</a>
				<a href="#mcp">MCP</a>
				<a href="${REPO}">GitHub</a>
				<a href="${NPM}">npm</a>
				<a href="/llms.txt">llms.txt</a>
			</nav>
			<button class="theme-toggle" type="button" aria-label="Toggle color theme">
				<span class="theme-icon" aria-hidden="true"></span>
			</button>
		</div>
	</header>

	<main id="top">
		<section class="hero">
			<div class="hero-rules" aria-hidden="true"></div>
			<div class="hero-glow" aria-hidden="true"></div>
			<div class="hero-inner">
				<div class="hero-copy">
					<p class="eyebrow">
						<span class="eyebrow-dot" aria-hidden="true"></span>
						Temporal GraphRAG · libSQL · Postgres · DuckDB
					</p>
					<h1 class="hero-title">${escapeHtml(title)}</h1>
					<p class="hero-tagline">${escapeHtml(tagline)}</p>
					<div class="hero-actions">
						<div class="install-group">
							<div class="pm-tabs" role="tablist" aria-label="Package manager">
								${(['bun', 'npm', 'pnpm'] as const)
									.map(
										(pm, i) =>
											`<button class="pm-tab${i === 0 ? ' is-active' : ''}" type="button" role="tab" aria-selected="${i === 0}" data-pm="${pm}">${pm}</button>`,
									)
									.join('')}
							</div>
							<button class="install" type="button" data-copy="${escapeHtml(install.bun)}" data-install-bun="${escapeHtml(install.bun)}" data-install-npm="${escapeHtml(install.npm)}" data-install-pnpm="${escapeHtml(install.pnpm)}">
								<span class="prompt" aria-hidden="true">$</span>
								<code>${escapeHtml(install.bun)}</code>
								<span class="copy-state">copy</span>
							</button>
						</div>
						<div class="hero-links">
							<a class="btn btn-primary" href="#quickstart">Read the docs</a>
							<a class="btn" href="${REPO}">
								<svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
									<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
								</svg>
								GitHub
							</a>
						</div>
					</div>
				</div>
				<div class="hero-visual">
					<!--
					  The arc of using the library, in three panels. Every panel is in
					  the DOM and the tabs only switch which is shown, so the swap
					  costs nothing and works before the module loads.
					-->
					<figure class="panels">
						<figcaption class="panel-bar">
							<span class="panel-tabs" role="tablist" aria-label="Example">
								${PANELS.map(
									(panel, i) =>
										`<button class="panel-tab${i === 0 ? ' is-active' : ''}" type="button" role="tab" aria-selected="${i === 0}" data-panel-tab="${i}">${escapeHtml(panel.label)}</button>`,
								).join('')}
							</span>
							<span class="code-lang">typescript</span>
						</figcaption>
						${PANELS.map(
							(panel, i) =>
								`<div class="panel${i === 0 ? ' is-active' : ''}" data-panel="${i}">${highlight(panel.code, panel.lang)}</div>`,
						).join('')}
					</figure>
				</div>
			</div>
		</section>

		<section class="pitch" aria-label="Why graphx">
			<div class="pitch-inner">
				<div class="pillars">
					${PILLARS.map(
						(p, i) => `<div class="pillar">
						<span class="pillar-num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
						<h2 class="pillar-title">${escapeHtml(p.title)}</h2>
						<p class="pillar-body">${p.body}</p>
					</div>`,
					).join('')}
				</div>
			</div>
		</section>

		<div class="layout">
			<article class="prose" id="content">
				${body}
			</article>
			<aside class="rail" aria-label="On this page">
				<p class="rail-head">On this page</p>
				<ul>${rail}</ul>
			</aside>
		</div>
	</main>

	<footer class="footer">
		<div class="footer-inner">
			<nav class="footer-links">
				<a href="${REPO}">GitHub</a>
				<a href="${NPM}">npm</a>
				<a href="/llms.txt">llms.txt</a>
			</nav>
		</div>
	</footer>`;

	// The README's tagline is a paragraph; a <title> wants one clause and a
	// meta description is truncated by search engines past ~160 characters.
	const lede = tagline.split(/(?<=\.)\s/)[0] ?? tagline;
	return {
		html,
		title: `${title} — ${lede.replace(/\.$/, '')}`,
		description: summarise(tagline),
	};
}
