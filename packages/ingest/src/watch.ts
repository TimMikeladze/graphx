import { watch } from 'node:fs';
import type { GraphSchema } from 'core';
import { ingestDir } from './ingest.ts';
import type { IngestOptions, IngestResult } from './types.ts';

export interface WatchOptions<S extends GraphSchema> extends IngestOptions<S> {
	/** Debounce window in ms before a batch of FS events triggers one ingest. Default 200. */
	debounceMs?: number;
	/** Called after each ingest run completes. */
	onRun?: (result: IngestResult) => void;
}

export interface Watcher {
	close(): void;
}

export function watchDir<S extends GraphSchema>(opts: WatchOptions<S>): Watcher {
	if (!opts.dir) throw new Error('watchDir: requires `dir` (filesystem-only)');

	const debounceMs = opts.debounceMs ?? 200;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let pending = false;
	let closed = false;

	async function runOnce(): Promise<void> {
		running = true;
		try {
			const result = await ingestDir(opts);
			opts.onRun?.(result);
		} finally {
			running = false;
			if (pending && !closed) {
				pending = false;
				scheduleRun();
			}
		}
	}

	function scheduleRun(): void {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			if (closed) return;
			if (running) {
				// Ingest already in flight — set trailing flag
				pending = true;
			} else {
				runOnce();
			}
		}, debounceMs);
	}

	const watcher = watch(opts.dir, { recursive: true }, (_event, _filename) => {
		if (closed) return;
		scheduleRun();
	});

	return {
		close() {
			closed = true;
			watcher.close();
			if (debounceTimer !== null) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
		},
	};
}
