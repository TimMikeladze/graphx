import { defineWorkspace } from 'bunup';

// https://bunup.dev/docs/guide/workspaces

export default defineWorkspace([
	{
		name: 'core',
		root: 'packages/core',
		// `pg.ts` ships as the `core/pg` subpath: importing it once registers the
		// Postgres driver with `getDb` (side effect). It stays a separate entry so the
		// optional `pg` peer is only pulled in by consumers that opt into Postgres.
		config: {
			entry: ['src/index.ts', 'src/pg.ts', 'src/blob.ts'],
		},
	},
	{
		name: 'ingest',
		root: 'packages/ingest',
		// `s3.ts` ships as the `ingest/s3` subpath: importing it once brings in the
		// S3 source. It stays a separate entry so the optional `@aws-sdk/client-s3`
		// peer is only pulled in by consumers that opt into S3 (mirrors core/pg).
		config: {
			entry: ['src/index.ts', 'src/s3.ts'],
		},
	},
	{
		name: 'cli',
		root: 'packages/cli',
		// The shebang makes dist/cli.js directly executable as a bin.
		config: {
			entry: ['src/cli.ts'],
			banner: '#!/usr/bin/env bun',
		},
	},
]);
