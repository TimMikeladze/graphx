import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadCatalog, readRelease, type DatasetSource } from '../src/download';

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const release = { date: '2026-10-18', version: '5.3.0+20261018' };
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'mtg-download-'));
	tempDirs.push(root);
	const dataDir = join(root, 'data');
	await mkdir(dataDir);
	const sources: DatasetSource[] = [
		{ name: 'AtomicCards', archive: 'AtomicCards.json.xz', file: 'AtomicCards.json' },
		{ name: 'Meta', archive: 'Meta.json.xz', file: 'Meta.json' },
	];
	const payloads = new Map<string, Uint8Array>();
	for (const source of sources) {
		const file = join(root, source.file);
		await writeFile(file, JSON.stringify({ meta: release, data: { example: source.name } }));
		const proc = Bun.spawn(['xz', '-c', file], { stdout: 'pipe' });
		payloads.set(source.archive, new Uint8Array(await new Response(proc.stdout).arrayBuffer()));
		expect(await proc.exited).toBe(0);
	}
	const state = { corrupt: false, noArchives: false, requests: 0 };
	const request = async (url: string | URL | Request) => {
		const name = String(url).split('/').at(-1)!;
		if (name.endsWith('.sha256'))
			return new Response(
				createHash('sha256')
					.update(payloads.get(name.slice(0, -7))!)
					.digest('hex'),
			);
		state.requests++;
		if (state.noArchives) return new Response('Unavailable', { status: 503 });
		return new Response(Uint8Array.from(state.corrupt ? [1, 2, 3] : payloads.get(name)!));
	};
	return { root, dataDir, sources, payloads, state, request };
}

describe('MTGJSON release download', () => {
	test('installs checked archives and reuses the validated cache', async () => {
		const f = await fixture();
		const result = await downloadCatalog({
			dataDir: f.dataDir,
			sources: f.sources,
			fetch: f.request,
		});
		expect(result.release).toEqual(release);
		expect(
			result.datasets.map((d) => ({
				name: d.name,
				file: d.file,
				date: d.date,
				version: d.version,
			})),
		).toEqual([
			{ name: 'AtomicCards', file: 'AtomicCards.json', ...release },
			{ name: 'Meta', file: 'Meta.json', ...release },
		]);
		expect(JSON.parse(await readFile(join(f.dataDir, 'manifest.json'), 'utf8'))).toEqual(result);
		expect(
			JSON.parse(await readFile(join(f.dataDir, 'AtomicCards.json'), 'utf8')).data.example,
		).toBe('AtomicCards');
		f.state.noArchives = true;
		await downloadCatalog({ dataDir: f.dataDir, sources: f.sources, fetch: f.request });
		expect(f.state.requests).toBe(2);
	});
	test('a checksum failure preserves every installed file and manifest', async () => {
		const f = await fixture();
		await writeFile(join(f.dataDir, 'AtomicCards.json'), 'previous catalog');
		await writeFile(join(f.dataDir, 'manifest.json'), 'previous manifest');
		f.state.corrupt = true;
		await expect(
			downloadCatalog({ dataDir: f.dataDir, sources: f.sources, fetch: f.request }),
		).rejects.toThrow(/SHA-256/);
		expect(await readFile(join(f.dataDir, 'AtomicCards.json'), 'utf8')).toBe('previous catalog');
		expect(await readFile(join(f.dataDir, 'manifest.json'), 'utf8')).toBe('previous manifest');
	});
	test('different release metadata rejects the whole install', async () => {
		const f = await fixture();
		const meta = join(f.root, 'different.json');
		await writeFile(
			meta,
			JSON.stringify({ meta: { date: '2026-10-17', version: '5.3.0+20261017' }, data: {} }),
		);
		const p = Bun.spawn(['xz', '-c', meta], { stdout: 'pipe' });
		f.payloads.set('Meta.json.xz', new Uint8Array(await new Response(p.stdout).arrayBuffer()));
		await p.exited;
		await writeFile(join(f.dataDir, 'AtomicCards.json'), 'previous catalog');
		await expect(
			downloadCatalog({ dataDir: f.dataDir, sources: f.sources, fetch: f.request }),
		).rejects.toThrow(/release/i);
		expect(await readFile(join(f.dataDir, 'AtomicCards.json'), 'utf8')).toBe('previous catalog');
		expect(await Bun.file(join(f.dataDir, 'manifest.json')).exists()).toBe(false);
	});
	test('rejects links in deck archives before extraction', async () => {
		const f = await fixture();
		await mkdir(join(f.root, 'unsafe'));
		await Bun.$`ln -s /tmp ${join(f.root, 'unsafe', 'escape')}`.quiet();
		const archive = join(f.root, 'unsafe.tar.xz');
		const p = Bun.spawn(['tar', '-cJf', archive, '-C', join(f.root, 'unsafe'), '.']);
		expect(await p.exited).toBe(0);
		f.sources.push({ name: 'AllDeckFiles', archive: 'AllDeckFiles.tar.xz', file: 'decks' });
		f.payloads.set('AllDeckFiles.tar.xz', new Uint8Array(await readFile(archive)));
		await expect(
			downloadCatalog({ dataDir: f.dataDir, sources: f.sources, fetch: f.request }),
		).rejects.toThrow(/regular|unsafe|link/i);
		expect(await Bun.file(join(f.dataDir, 'manifest.json')).exists()).toBe(false);
	});
});

test('extracts Unicode deck filenames and records the deck release', async () => {
	const f = await fixture();
	const dir = join(f.root, 'AllDeckFiles');
	await mkdir(dir);
	await writeFile(
		join(dir, 'Mahō魔法学院_SLD.json'),
		JSON.stringify({ meta: release, data: { name: '魔法学院', mainBoard: [] } }),
	);
	const archive = join(f.root, 'decks.tar.xz');
	const p = Bun.spawn(['tar', '-cJf', archive, '-C', f.root, 'AllDeckFiles']);
	expect(await p.exited).toBe(0);
	f.sources.push({ name: 'AllDeckFiles', archive: 'AllDeckFiles.tar.xz', file: 'decks' });
	f.payloads.set('AllDeckFiles.tar.xz', new Uint8Array(await readFile(archive)));
	const manifest = await downloadCatalog({
		dataDir: f.dataDir,
		sources: f.sources,
		fetch: f.request,
	});
	expect(manifest.datasets.at(-1)?.file).toBe('decks');
	expect(
		JSON.parse(
			await readFile(join(f.dataDir, 'decks', 'AllDeckFiles', 'Mahō魔法学院_SLD.json'), 'utf8'),
		).data.name,
	).toBe('魔法学院');
});

// Deck exports put metadata after the data object, including decks larger than a prefix read.
test('reads release metadata at the end of a large deck JSON file', async () => {
	const f = await fixture();
	const path = join(f.root, 'large-deck.json');
	await writeFile(path, JSON.stringify({ data: { text: 'x'.repeat(150000) }, meta: release }));
	expect(await readRelease(path)).toEqual(release);
});

test('upstream checksum rotation preserves the installed release', async () => {
	const f = await fixture();
	await writeFile(join(f.dataDir, 'AtomicCards.json'), 'previous catalog');
	await writeFile(join(f.dataDir, 'manifest.json'), 'previous manifest');
	let checksums = 0;
	const request = async (url: string) => {
		if (url.endsWith('.sha256') && ++checksums > 2) return new Response('0'.repeat(64));
		return f.request(url);
	};
	await expect(
		downloadCatalog({ dataDir: f.dataDir, sources: f.sources, fetch: request }),
	).rejects.toThrow(/release changed/i);
	expect(await readFile(join(f.dataDir, 'AtomicCards.json'), 'utf8')).toBe('previous catalog');
	expect(await readFile(join(f.dataDir, 'manifest.json'), 'utf8')).toBe('previous manifest');
});

test('a traversal deck entry cannot write outside the staging directory', async () => {
	const f = await fixture();
	const body = Buffer.from('{}');
	const header = Buffer.alloc(512);
	header.write('../escaped.json');
	header.write('0000644\0', 100);
	header.write('0000000\0', 108);
	header.write('0000000\0', 116);
	header.write('00000000002\0', 124);
	header.write('00000000000\0', 136);
	header.fill(32, 148, 156);
	header[156] = 48;
	const sum = header.reduce((total, byte) => total + byte, 0);
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
	const tar = join(f.root, 'traversal.tar');
	await writeFile(tar, Buffer.concat([header, body, Buffer.alloc(510 + 1024)]));
	const p = Bun.spawn(['xz', '-c', tar], { stdout: 'pipe' });
	f.payloads.set('AllDeckFiles.tar.xz', new Uint8Array(await new Response(p.stdout).arrayBuffer()));
	expect(await p.exited).toBe(0);
	f.sources.push({ name: 'AllDeckFiles', archive: 'AllDeckFiles.tar.xz', file: 'decks' });
	await expect(
		downloadCatalog({ dataDir: f.dataDir, sources: f.sources, fetch: f.request }),
	).rejects.toThrow(/unsafe/i);
	expect(await Bun.file(join(f.dataDir, 'escaped.json')).exists()).toBe(false);
	expect(await Bun.file(join(f.dataDir, 'manifest.json')).exists()).toBe(false);
});
