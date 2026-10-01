/**
 * Minimal reusable MediaWiki action-API client for scraping.
 *
 * Design goals (this is the piece we re-run often):
 * - **Disk-cached**: every GET response lands in `.cache/requests/<sha>.json` keyed by URL, so a
 *   re-run is a diff — unchanged pages are never re-fetched (unless `--fresh` busts the TTL).
 * - **Polite**: bounded concurrency with minimum spacing between request starts, retries with
 *   exponential backoff + jitter on 429/5xx/network errors, and a plain browser User-Agent that
 *   carries no identifying information.
 *
 * No dependencies — `fetch` + `node:fs`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WikiOptions {
	apiUrl?: string;
	/** Cache directory for raw responses. Default: `<cwd>/.cache/requests`. */
	cacheDir?: string;
	/** Max in-flight requests. Default 2 — anonymous API budget is best spent serially. */
	concurrency?: number;
	/** Minimum spacing between request starts (ms). Default 1200. */
	spacingMs?: number;
	/** Total attempts per request before giving up. Default 6. */
	attempts?: number;
	timeoutMs?: number;
}

/** Deliberately non-identifying: a stock browser header, nothing about who is asking. */
const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CacheEntry {
	url: string;
	fetchedAt: number;
	status: number;
	body: string;
}

export interface PageContent {
	title: string;
	wikitext: string;
	timestamp?: string;
}

export interface RecentChange {
	type: 'edit' | 'new' | 'log' | 'categorize';
	title: string;
	timestamp: string;
}

export interface Wiki {
	/** GET an action-API URL as JSON, through cache/TTL/retry/rate-limit. */
	fetchJson(url: string, ttlMs?: number): Promise<unknown>;
	/** Fetch article wikitext for many titles (batched 20/request, redirect-resolved). */
	getPages(
		titles: string[],
		opts?: { ttlMs?: number; onBatch?: (done: number, total: number) => void },
	): Promise<Map<string, PageContent>>;
	/** All ns-0 article links on a page (follows `continue`). */
	getLinks(page: string, ttlMs?: number): Promise<string[]>;
	/** Article-space changes newer than `since` (ISO). Empty `since` ⇒ most recent window. */
	getRecentChanges(since?: string): Promise<{ changes: RecentChange[]; latest: string | null }>;
}

export function createWiki(opts: WikiOptions = {}): Wiki {
	const apiUrl = opts.apiUrl ?? 'https://en.wikipedia.org/w/api.php';
	const cacheDir = opts.cacheDir ?? join(process.cwd(), '.cache', 'requests');
	const concurrency = opts.concurrency ?? 2;
	const spacingMs = opts.spacingMs ?? 1200;
	const attempts = opts.attempts ?? 6;
	const timeoutMs = opts.timeoutMs ?? 30_000;

	mkdirSync(cacheDir, { recursive: true });
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// --- rate limiter: a semaphore + a start-time spacing queue -------------------------------

	let inFlight = 0;
	let lastStart = 0;
	const waiters: Array<() => void> = [];

	function release() {
		const next = waiters.shift();
		if (next) next();
		else inFlight--;
	}

	async function acquire(): Promise<void> {
		if (inFlight < concurrency) {
			inFlight++;
		} else {
			await new Promise<void>((resolve) => waiters.push(resolve));
		}
		const gap = spacingMs - (Date.now() - lastStart);
		if (gap > 0) await sleep(gap);
		lastStart = Date.now();
	}

	// --- raw fetch with retries + cache --------------------------------------------------------

	function cacheRead(url: string, ttlMs: number): CacheEntry | null {
		try {
			const entry = JSON.parse(
				readFileSync(join(cacheDir, sha(url) + '.json'), 'utf8'),
			) as CacheEntry;
			if (entry.url !== url) return null; // hash collision guard
			if (Date.now() - entry.fetchedAt > ttlMs) return null;
			return entry;
		} catch {
			return null;
		}
	}

	function cacheWrite(entry: CacheEntry) {
		writeFileSync(join(cacheDir, sha(entry.url) + '.json'), JSON.stringify(entry));
	}

	async function fetchJson(url: string, ttlMs: number | undefined): Promise<unknown> {
		const ttl = ttlMs ?? Number.POSITIVE_INFINITY;
		const cached = cacheRead(url, ttl);
		if (cached) return JSON.parse(cached.body);

		let lastError = 'unknown error';
		let retryAfterMs = 0;
		for (let attempt = 0; attempt < attempts; attempt++) {
			// 429/5xx backoff is deliberately patient: the anonymous API budget refills over
			// tens of seconds, and hammering only extends the penalty window.
			const wait = retryAfterMs || (attempt === 0 ? 0 : Math.min(60_000, 2000 * 2 ** attempt));
			if (wait > 0) await sleep(wait + Math.random() * 500);
			retryAfterMs = 0;
			await acquire();
			let res: Response;
			try {
				res = await fetch(url, {
					headers: { 'user-agent': UA, accept: 'application/json' },
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (err) {
				release();
				lastError = `network: ${(err as Error).message}`;
				continue;
			}
			if (res.status === 429 || res.status >= 500) {
				const header = res.headers.get('retry-after');
				retryAfterMs = header ? Math.max(1000, Number(header) * 1000) : 30_000;
				lastError = `http ${res.status}`;
				await res.text().catch(() => {});
				release();
				continue;
			}
			const text = await res.text();
			release();
			if (!res.ok) throw new Error(`wiki: http ${res.status} for ${hostOnly(url)}`);
			cacheWrite({ url, fetchedAt: Date.now(), status: res.status, body: text });
			return JSON.parse(text);
		}
		throw new Error(`wiki: ${lastError} after ${attempts} attempts (${hostOnly(url)})`);
	}

	function apiUrlWith(params: Record<string, string>): string {
		const qs = new URLSearchParams({ format: 'json', ...params });
		return `${apiUrl}?${qs}`;
	}

	// --- page content ---------------------------------------------------------------------------

	async function getPages(
		titles: string[],
		o?: { ttlMs?: number; onBatch?: (done: number, total: number) => void },
	): Promise<Map<string, PageContent>> {
		const out = new Map<string, PageContent>();
		const BATCH = 50;
		for (let i = 0; i < titles.length; i += BATCH) {
			const batch = titles.slice(i, i + BATCH);
			const data = (await fetchJson(
				apiUrlWith({
					action: 'query',
					prop: 'revisions',
					rvprop: 'content|timestamp',
					rvslots: 'main',
					redirects: '1',
					titles: batch.join('|'),
				}),
				o?.ttlMs,
			)) as ApiQuery;

			// Map every requested title to its resolved title through normalize + redirect chains.
			const resolve = new Map<string, string>();
			for (const n of data.query?.normalized ?? []) resolve.set(n.from, n.to);
			for (const r of data.query?.redirects ?? []) {
				const from = resolve.get(r.from) ?? r.from;
				resolve.set(from, r.to);
				resolve.set(r.from, r.to);
			}

			for (const page of Object.values(data.query?.pages ?? {})) {
				const rev = page.revisions?.[0];
				if (page.missing !== undefined || !rev?.slots?.main) continue;
				const content: PageContent = {
					title: page.title,
					wikitext: (rev.slots.main['*'] ?? '') as string,
					timestamp: rev.timestamp,
				};
				out.set(page.title, content);
				for (const [from, to] of resolve) {
					if (to === page.title && !out.has(from)) out.set(from, content);
				}
			}
			o?.onBatch?.(Math.min(i + BATCH, titles.length), titles.length);
		}
		return out;
	}

	// --- links on a page ------------------------------------------------------------------------

	async function getLinks(page: string, ttlMs?: number): Promise<string[]> {
		const links: string[] = [];
		let plcontinue: string | undefined;
		do {
			const params: Record<string, string> = {
				action: 'parse',
				page,
				prop: 'links',
				pllimit: '500',
			};
			if (plcontinue) params.plcontinue = plcontinue;
			const data = (await fetchJson(apiUrlWith(params), ttlMs ?? 86_400_000)) as ApiParse;
			for (const l of data.parse?.links ?? []) {
				if (l.ns === 0 && !l['*'].startsWith('List of')) links.push(l['*']);
			}
			plcontinue = (data.continue?.plcontinue as string | undefined) ?? undefined;
		} while (plcontinue);
		return [...new Set(links)];
	}

	// --- recent changes (the tail) ---------------------------------------------------------------

	async function getRecentChanges(
		since?: string,
	): Promise<{ changes: RecentChange[]; latest: string | null }> {
		const changes: RecentChange[] = [];
		let rccontinue: string | undefined;
		let latest: string | null = since ?? null;
		do {
			const params: Record<string, string> = {
				action: 'query',
				list: 'recentchanges',
				rctype: 'edit|new',
				rctoponly: '1',
				rcnamespace: '0',
				rcprop: 'title|timestamp|ids|type',
				rclimit: '500',
			};
			// Walk NEWER than the watermark (`rcdir=newer` needs the start anchor).
			if (since) {
				params.rcstart = since;
				params.rcdir = 'newer';
			} else {
				params.rclimit = '500';
			}
			if (rccontinue) params.rccontinue = rccontinue;
			const data = (await fetchJson(apiUrlWith(params), 0)) as ApiRc;
			for (const rc of data.query?.recentchanges ?? []) {
				if (rc.type !== 'edit' && rc.type !== 'new') continue;
				changes.push({ type: rc.type, title: rc.title, timestamp: rc.timestamp });
				if (!latest || rc.timestamp > latest) latest = rc.timestamp;
			}
			rccontinue = (data.continue?.rccontinue as string | undefined) ?? undefined;
			// A walk with `since` ends at "now" naturally via batchcomplete/continue exhaustion.
		} while (rccontinue && changes.length < 5_000);
		return { changes, latest };
	}

	return { fetchJson, getPages, getLinks, getRecentChanges };
}

// --- tiny internal helpers ---------------------------------------------------------------------

function sha(url: string): string {
	return createHash('sha256').update(url).digest('hex');
}

function hostOnly(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

// --- action API response shapes (only the fields we read) ----------------------------------------

interface ApiQuery {
	query?: {
		normalized?: Array<{ from: string; to: string }>;
		redirects?: Array<{ from: string; to: string }>;
		pages?: Record<
			string,
			{
				title: string;
				missing?: string;
				revisions?: Array<{ timestamp?: string; slots?: Record<string, { '*': string }> }>;
			}
		>;
	};
	continue?: Record<string, string>;
}

interface ApiParse {
	parse?: { links?: Array<{ ns: number; '*': string }> };
	continue?: Record<string, string>;
}

interface ApiRc {
	query?: { recentchanges?: Array<{ type: string; title: string; timestamp: string }> };
	continue?: Record<string, string>;
}
