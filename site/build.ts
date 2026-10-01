/** Writes every artefact into public/, which is what gets deployed and what is committed. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderCard } from './card.ts';
import { siteDir } from './readme.ts';
import { renderSite } from './render.ts';

export const publicDir = path.join(siteDir, 'public');

export async function build(): Promise<string[]> {
	await mkdir(publicDir, { recursive: true });
	const files = await renderSite();
	for (const [name, text] of Object.entries(files))
		await writeFile(path.join(publicDir, name), text);
	await writeFile(path.join(publicDir, 'og.png'), await renderCard());
	return [...Object.keys(files), 'og.png'];
}

if (import.meta.main) {
	const written = await build();
	console.log(`Wrote ${written.length} files to site/public: ${written.join(', ')}`);
}
