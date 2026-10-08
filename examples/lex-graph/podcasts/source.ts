/**
 * The contract every show in `podcasts/` implements, and the one fetch they all use.
 */
import { join } from 'node:path';
import type { Episode } from '../parse.ts';

export interface Podcast {
	/** Stable key: the `podcast` field of its episodes and its node's natural key. */
	key: string;
	name: string;
	/** Prefix for an episode's short caption: `Lex #252 Elon Musk`. */
	short: string;
	host: string;
	/** The show's home page. */
	url: string;
	/** Cover art; the picture for episodes that have no video thumbnail. */
	image?: string;
	/** The URLs the scrape reads, recorded on the `dataset` node. */
	sources: string[];
	/**
	 * Fetch the show into `dir` and return its episodes. The raw responses stay in `dir`, and
	 * `offline` re-parses them without touching the network.
	 */
	scrape(dir: string, opts: { offline: boolean }): Promise<Episode[]>;
}

const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function fetchText(url: string): Promise<string> {
	// A generic browser UA and nothing else: no cookies, no identifying headers. (Sean Carroll's
	// site answers a bare `Mozilla/5.0` with 406.)
	const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return res.text();
}

/** `dir/name` as text: fetched from `url` and saved first, unless offline. */
export async function cached(
	dir: string,
	name: string,
	url: string,
	offline: boolean,
): Promise<string> {
	const path = join(dir, name);
	if (!offline) await Bun.write(path, await fetchText(url));
	return Bun.file(path).text();
}
