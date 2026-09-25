/**
 * The root README is the documentation, and npm shows the package directory's README on the
 * package page — so this writes one from the other rather than letting a second copy drift.
 * `test/readme-sync.test.ts` fails when they disagree; run `bun run sync:readme` to fix it.
 *
 * One thing changes on the way across: repo-relative links (`./examples/…`) have nothing to
 * resolve against on npm, so they are pointed at GitHub.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = 'https://github.com/TimMikeladze/graphx';
const ROOT = path.resolve(import.meta.dir, '..');

export const SOURCE: string = path.join(ROOT, 'README.md');
export const TARGET: string = path.join(ROOT, 'packages/graphx/README.md');

export function packageReadme(md: string): string {
	return md.replace(/\]\(\.\/([^)]+)\)/g, `](${REPO}/blob/main/$1)`);
}

if (import.meta.main) {
	await writeFile(TARGET, packageReadme(await readFile(SOURCE, 'utf8')));
	console.log(`Wrote ${path.relative(ROOT, TARGET)} from ${path.relative(ROOT, SOURCE)}`);
}
