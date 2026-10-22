/**
 * Download and unzip the King County Metro GTFS feed into `data/gtfs`. Re-downloads only when
 * the server's copy is newer (`If-Modified-Since`). No identifying headers are sent.
 *
 *   bun src/download.ts
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const GTFS_URL = 'https://metro.kingcounty.gov/GTFS/google_transit.zip';
export const DATA = join(import.meta.dir, '../data');

export async function download(dir = DATA): Promise<string> {
	mkdirSync(dir, { recursive: true });
	const zip = join(dir, 'google_transit.zip');
	const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0' };
	if (existsSync(zip)) headers['if-modified-since'] = statSync(zip).mtime.toUTCString();
	const res = await fetch(GTFS_URL, { headers });
	if (res.status === 304) console.log('  feed unchanged');
	else if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
	else {
		await Bun.write(zip, res);
		console.log(`  ${(statSync(zip).size / 1e6).toFixed(1)} MB → ${zip}`);
	}
	const out = join(dir, 'gtfs');
	mkdirSync(out, { recursive: true });
	const unzip = Bun.spawnSync(['unzip', '-o', '-q', zip, '-d', out]);
	if (unzip.exitCode !== 0) throw new Error(`unzip failed: ${unzip.stderr.toString()}`);
	return out;
}

if (import.meta.main) await download();
