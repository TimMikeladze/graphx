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
	{
		name: 'mcp',
		root: 'packages/mcp',
		// `bin.ts` is a separate entry so `dist/bin.js` is the executable the `graphx-mcp`
		// bin points at; the shebang makes it runnable directly (mirrors cli).
		config: {
			entry: ['src/index.ts', 'src/bin.ts'],
			banner: '#!/usr/bin/env bun',
		},
	},
	{
		name: 'react',
		root: 'packages/react',
		// React Query hooks layered over core's HTTP surface. `dts.inferTypes` makes bunup use
		// TypeScript's compiler (not isolated declarations) to EMIT the inferred types — the
		// generic `createGraphHooks` return (the whole hook set) can't be expressed under isolated
		// declarations, so without this the published `.d.ts` collapses it to `{}`.
		config: {
			entry: ['src/index.ts'],
			dts: { inferTypes: true },
		},
	},
]);
