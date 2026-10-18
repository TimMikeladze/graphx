import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
	access,
	mkdir,
	mkdtemp,
	open,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DatasetSource {
	name: string;
	archive: string;
	file: string;
}
export interface CatalogRelease {
	date: string;
	version: string;
}
export interface DownloadManifest {
	release: CatalogRelease;
	datasets: Array<
		CatalogRelease & { name: string; file: string; sha256: string; bytes: number; source: string }
	>;
}
export const CATALOG_SOURCES: DatasetSource[] = [
	'AtomicCards',
	'AllPrintings',
	'AllDeckFiles',
	'AllIdentifiers',
	'AllPrices',
	'AllPricesToday',
	'TcgplayerSkus',
	'CardmarketIdentifiers',
	'SetList',
	'DeckList',
	'CardTypes',
	'Keywords',
	'EnumValues',
	'CompiledList',
	'Meta',
].map((name) => ({
	name,
	archive: `${name}${name === 'AllDeckFiles' ? '.tar' : '.json'}.xz`,
	file: name === 'AllDeckFiles' ? 'decks' : `${name}.json`,
}));

type Fetch = (url: string) => Promise<Response>;
interface DownloadOptions {
	dataDir: string;
	sources?: DatasetSource[];
	baseUrl?: string;
	fetch?: Fetch;
	log?: (message: string) => void;
}
async function exists(file: string) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}
async function sha256(file: string) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest('hex');
}
async function checksum(request: Fetch, url: string) {
	const response = await request(`${url}.sha256`);
	if (!response.ok) throw new Error(`Checksum request failed: ${response.status} ${url}`);
	const hash = (await response.text()).trim().split(/\s+/)[0]!;
	if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error(`Invalid SHA-256 checksum: ${url}`);
	return hash.toLowerCase();
}
async function decompress(archive: string, destination: string) {
	const process = Bun.spawn(['xz', '-dc', archive], {
		stdout: Bun.file(destination),
		stderr: 'inherit',
	});
	if ((await process.exited) !== 0) throw new Error(`xz decompression failed: ${archive}`);
}
export async function readRelease(file: string): Promise<CatalogRelease> {
	const handle = await open(file, 'r');
	try {
		const prefix = Buffer.alloc(65536);
		const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
		let match = prefix.toString('utf8', 0, bytesRead).match(/"meta"\s*:\s*(\{[^{}]*\})/);
		if (!match) {
			const size = (await handle.stat()).size;
			const tail = Buffer.alloc(Math.min(size, 65536));
			await handle.read(tail, 0, tail.length, size - tail.length);
			match = tail.toString('utf8').match(/"meta"\s*:\s*(\{[^{}]*\})\s*\}\s*$/);
		}
		const meta = match ? JSON.parse(match[1]!) : null;
		if (
			!meta ||
			typeof meta.date !== 'string' ||
			typeof meta.version !== 'string' ||
			!/^\d{4}-\d{2}-\d{2}$/.test(meta.date) ||
			!meta.version
		)
			throw new Error(`Missing release metadata in ${file}`);
		return { date: meta.date, version: meta.version };
	} finally {
		await handle.close();
	}
}
function sameRelease(actual: CatalogRelease, expected: CatalogRelease, file: string) {
	if (actual.date !== expected.date || actual.version !== expected.version)
		throw new Error(
			`MTGJSON release mismatch in ${file}: ${actual.date}/${actual.version}, expected ${expected.date}/${expected.version}`,
		);
}
async function commandOutput(args: string[]) {
	const process = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
	const [output, error, status] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (status !== 0) throw new Error(`${args[0]} failed: ${error}`);
	return output;
}
async function extractDecks(archive: string, destination: string, stage: string) {
	const tarFile = join(stage, 'decks.tar');
	await decompress(archive, tarFile);
	const [listing, verbose] = await Promise.all([
		commandOutput(['tar', '-tf', tarFile]),
		commandOutput(['tar', '-tvf', tarFile]),
	]);
	const names = listing.trimEnd().split('\n');
	const entries = verbose.trimEnd().split('\n');
	if (!listing.trim() || names.length !== entries.length)
		throw new Error('Unsafe deck archive listing');
	for (const [index, name] of names.entries()) {
		// Reject links, devices, traversal, escaped names and control characters before tar writes anything.
		if (
			!/^[d-]/.test(entries[index]!) ||
			!name ||
			Array.from(name).some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\',
			) ||
			name.startsWith('/') ||
			name.split('/').includes('..')
		)
			throw new Error(
				`Unsafe deck archive entry; only regular files and directories are allowed: ${name}`,
			);
	}
	await mkdir(destination, { recursive: true });
	await commandOutput([
		'tar',
		'-xf',
		tarFile,
		'-C',
		destination,
		'--no-same-owner',
		'--no-same-permissions',
	]);
	await rm(tarFile);
}
async function deckFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await deckFiles(path)));
		else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
		else throw new Error(`Unexpected deck archive file: ${path}`);
	}
	return files;
}
async function publish(stage: string, dataDir: string, files: string[]) {
	const backup = join(stage, '.previous');
	await mkdir(backup);
	const changed: Array<{ file: string; previous: boolean; installed: boolean }> = [];
	try {
		for (const file of files) {
			const item = { file, previous: await exists(join(dataDir, file)), installed: false };
			changed.push(item);
			if (item.previous) await rename(join(dataDir, file), join(backup, file));
			await rename(join(stage, file), join(dataDir, file));
			item.installed = true;
		}
	} catch (error) {
		for (const item of changed.reverse()) {
			if (item.installed) await rm(join(dataDir, item.file), { recursive: true, force: true });
			if (item.previous) await rename(join(backup, item.file), join(dataDir, item.file));
		}
		throw error;
	}
}
export async function downloadCatalog(options: DownloadOptions): Promise<DownloadManifest> {
	const {
		dataDir,
		sources = CATALOG_SOURCES,
		baseUrl = 'https://mtgjson.com/api/v5',
		fetch: request = fetch,
		log = () => {},
	} = options;
	await mkdir(dataDir, { recursive: true });
	const cacheDir = join(dataDir, '.download-cache');
	await mkdir(cacheDir, { recursive: true });
	const stage = await mkdtemp(join(dataDir, '.release-'));
	try {
		const sourcesWithHashes = await Promise.all(
			sources.map(async (source) => {
				if (
					!/^[A-Za-z0-9]+$/.test(source.name) ||
					!/^[A-Za-z0-9.]+$/.test(source.archive) ||
					!/^[A-Za-z0-9.]+$/.test(source.file)
				)
					throw new Error('Unsafe dataset source');
				const url = `${baseUrl}/${source.archive}`;
				return { ...source, url, hash: await checksum(request, url) };
			}),
		);
		const datasets: DownloadManifest['datasets'] = [];
		// Each archive is streamed to disk; decompression never loads a complete source into memory.
		for (const source of sourcesWithHashes) {
			let archive = join(cacheDir, `${source.hash}-${source.archive}`);
			const legacy = join(dataDir, source.archive);
			if ((await exists(archive)) && (await sha256(archive)) === source.hash)
				log(`Cached ${source.archive}`);
			else if ((await exists(legacy)) && (await sha256(legacy)) === source.hash) {
				archive = legacy;
				log(`Cached ${source.archive}`);
			} else {
				log(`Downloading ${source.archive}`);
				const response = await request(source.url);
				if (!response.ok || !response.body)
					throw new Error(`Download failed: ${response.status} ${source.url}`);
				const temporary = join(stage, `${source.archive}.partial`);
				const hash = createHash('sha256');
				await pipeline(
					Readable.fromWeb(response.body as never),
					new Transform({
						transform(chunk, _encoding, callback) {
							hash.update(chunk);
							callback(null, chunk);
						},
					}),
					createWriteStream(temporary),
				);
				if (hash.digest('hex') !== source.hash)
					throw new Error(
						`MTGJSON SHA-256 mismatch: ${source.archive}; installed catalog was preserved`,
					);
				await rename(temporary, archive);
			}
			if (source.name === 'AllDeckFiles')
				await extractDecks(archive, join(stage, source.file), stage);
			else await decompress(archive, join(stage, source.file));
			const releaseFiles =
				source.name === 'AllDeckFiles'
					? await deckFiles(join(stage, source.file))
					: [join(stage, source.file)];
			if (!releaseFiles.length) throw new Error('Deck archive is empty');
			const release = await readRelease(releaseFiles[0]!);
			for (const file of releaseFiles.slice(1)) sameRelease(await readRelease(file), release, file);
			datasets.push({
				name: source.name,
				file: source.file,
				sha256: source.hash,
				bytes: (await stat(archive)).size,
				...release,
				source: source.url,
			});
			log(
				`Verified ${source.name}: ${release.date} (${releaseFiles.length} file${releaseFiles.length === 1 ? '' : 's'})`,
			);
		}
		if (!datasets.length) throw new Error('No datasets requested');
		const release = { date: datasets[0]!.date, version: datasets[0]!.version };
		for (const dataset of datasets) sameRelease(dataset, release, dataset.name);
		// Upstream can rotate during a long download. Refuse to publish a mixture of releases.
		for (const source of sourcesWithHashes)
			if ((await checksum(request, source.url)) !== source.hash)
				throw new Error(`MTGJSON release changed during download: ${source.name}`);
		const manifest: DownloadManifest = { release, datasets };
		await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
		await publish(stage, dataDir, [...datasets.map((dataset) => dataset.file), 'manifest.json']);
		return manifest;
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}
