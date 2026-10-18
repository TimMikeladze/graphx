import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { downloadCatalog } from './src/download';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, 'data');
await mkdir(dataDir, { recursive: true });
const manifest = await downloadCatalog({ dataDir, log: console.log });
if (!(await Bun.file(join(dataDir, 'images.json')).exists())) {
	const metadata = await fetch('https://api.scryfall.com/bulk-data/oracle-cards', {
		headers: { 'User-Agent': 'CardDataClient/1.0', Accept: 'application/json' },
	});
	if (!metadata.ok) throw new Error('Scryfall bulk metadata download failed');
	const bulk = (await metadata.json()) as { jsonl_download_uri: string; updated_at: string };
	const imageResponse = await fetch(bulk.jsonl_download_uri);
	if (!imageResponse.ok || !imageResponse.body)
		throw new Error('Scryfall image metadata download failed');
	const input = createInterface({
		input: Readable.fromWeb(imageResponse.body as never).pipe(createGunzip()),
		crlfDelay: Infinity,
	});
	const images: Record<string, unknown> = {};
	for await (const line of input) {
		const c = JSON.parse(line);
		if (c.oracle_id)
			images[c.oracle_id] = {
				scryfallId: c.id,
				prices: {
					usd: c.prices?.usd ?? null,
					eur: c.prices?.eur ?? null,
					asOf: bulk.updated_at.slice(0, 10),
					source: 'Scryfall',
				},
			};
	}
	const imageTemp = join(root, 'data', 'images.json.tmp');
	await writeFile(imageTemp, JSON.stringify(images));
	await rename(imageTemp, join(root, 'data', 'images.json'));
}
console.log(
	`Verified ${manifest.datasets.length} MTGJSON datasets, ${manifest.release.date} (${manifest.release.version}). Run bun run ingest, then restart the app.`,
);
