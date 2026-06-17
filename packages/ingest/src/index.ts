import type { GraphSchema } from 'core';
import type { IngestOptions, IngestResult } from './types.ts';

export type { IngestOptions, IngestResult, ParsedFile } from './types.ts';

/** Ingest a local YAML/markdown vault into `opts.graph`. Implemented in later tasks. */
export async function ingestDir<S extends GraphSchema>(
	_opts: IngestOptions<S>,
): Promise<IngestResult> {
	throw new Error('ingestDir: not implemented');
}
