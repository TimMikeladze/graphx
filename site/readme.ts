/**
 * Reads the README the way the page needs it: fenced blocks (to resolve references against),
 * `##` sections (for the reference page and llms.txt) and the tables. Nothing here has copy.
 * A reference that matches zero blocks, or two, throws — that is the anti-drift guarantee.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Ref } from './content.ts';

export const siteDir = import.meta.dirname;
export const rootDir = path.resolve(siteDir, '..');

export async function readReadme(): Promise<string> {
	return readFile(path.join(rootDir, 'README.md'), 'utf8');
}

export async function readVersion(): Promise<string> {
	const pkg = JSON.parse(await readFile(path.join(rootDir, 'packages/graphx/package.json'), 'utf8'));
	return pkg.version as string;
}

export interface Block {
	lang: string;
	code: string;
}

/** Every fenced block, in order. Fences are only recognised at the start of a line. */
export function fencedBlocks(md: string): Block[] {
	return [...md.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)].map((m) => ({
		lang: m[1] ?? '',
		code: (m[2] ?? '').replace(/\n$/, ''),
	}));
}

export interface Resolved extends Block {
	/** Shown in the demo's title bar: `$ command` for a capture, a filename otherwise. */
	title: string;
	terminal: boolean;
	/** The command, for a captured run. */
	command?: string;
}

export function resolve(blocks: Block[], ref: Ref): Resolved {
	if (ref.kind === 'terminal') {
		const prefix = `$ ${ref.command}`;
		const hits = blocks.filter((b) => {
			const first = b.code.split('\n', 1)[0] ?? '';
			return first === prefix;
		});
		if (hits.length !== 1) {
			throw new Error(`terminal("${ref.command}") matched ${hits.length} README blocks, expected exactly 1`);
		}
		const [hit] = hits as [Block];
		return {
			...hit,
			// Drop the `$ command` line itself: the title bar carries it.
			code: hit.code.split('\n').slice(1).join('\n'),
			title: prefix,
			terminal: true,
			command: ref.command,
		};
	}
	const hits = blocks.filter((b) => b.code.split('\n').some((l) => l.includes(ref.line)));
	if (hits.length !== 1) {
		throw new Error(`snippet(${JSON.stringify(ref.line)}) matched ${hits.length} README blocks, expected exactly 1`);
	}
	const [hit] = hits as [Block];
	return { ...hit, title: ref.label, terminal: false };
}

export interface Table {
	header: string[];
	rows: string[][];
}

/** The README's markdown tables, parsed; `header` is matched against the first header cell. */
export function readTable(md: string, header: string): Table {
	const found: Table[] = [];
	const lines = md.split('\n');
	for (let i = 0; i < lines.length - 1; i++) {
		const head = lines[i] ?? '';
		if (!head.startsWith('|') || !/^\|[\s|:-]+\|$/.test(lines[i + 1] ?? '')) continue;
		const cells = (l: string) =>
			l
				.replace(/^\||\|$/g, '')
				.split('|')
				.map((c) => c.trim());
		const rows: string[][] = [];
		let j = i + 2;
		while ((lines[j] ?? '').startsWith('|')) rows.push(cells(lines[j++] ?? ''));
		found.push({ header: cells(head), rows });
	}
	const hits = found.filter((t) => t.header[0] === header);
	if (hits.length !== 1) throw new Error(`table("${header}") matched ${hits.length} README tables, expected exactly 1`);
	return hits[0] as Table;
}

/** Text of the first install fence: `bun add graphx`. */
export function readInstall(md: string): string {
	const m = /^```sh\n(bun add [^\n]+)\n```/m.exec(md);
	if (!m) throw new Error('README has no `bun add …` install fence');
	return m[1] as string;
}

/** GitHub's heading slug algorithm, so links written in the README resolve. */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\- ]+/g, '')
		.replace(/ /g, '-');
}

/** Every `##` heading outside a fence, in README order. */
export function readSections(md: string): { text: string; slug: string }[] {
	let fence = false;
	const out: { text: string; slug: string }[] = [];
	for (const line of md.split('\n')) {
		if (line.startsWith('```')) fence = !fence;
		const m = !fence && /^##\s+(.+)$/.exec(line);
		if (m) out.push({ text: (m[1] as string).trim(), slug: slugify(m[1] as string) });
	}
	return out;
}

/** The README as the reference page shows it: no title block, no page-furniture comments, links off-repo. */
export function referenceBody(md: string): string {
	const first = md.indexOf('\n## ');
	const body = first === -1 ? md : md.slice(first + 1);
	return body
		.replace(/\]\(\.\/([^)]+)\)/g, '](https://github.com/TimMikeladze/graphx/blob/main/$1)');
}
