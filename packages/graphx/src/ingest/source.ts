import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_INCLUDE, discover } from './discover.ts';

/** A pluggable file-source seam for ingestDir. */
export interface Source {
	/** Sorted POSIX keys relative to the source root. */
	list(): Promise<string[]>;
	/** UTF-8 contents of one key. */
	read(key: string): Promise<string>;
}

/** Wraps the local filesystem; the default Source used when `dir` is provided. */
export function fsSource(dir: string, include?: string[]): Source {
	const inc = include ?? DEFAULT_INCLUDE;
	return {
		list(): Promise<string[]> {
			return discover(dir, inc);
		},
		read(key: string): Promise<string> {
			return readFile(join(dir, key), 'utf8');
		},
	};
}
