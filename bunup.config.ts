import { defineWorkspace } from 'bunup';

// https://bunup.dev/docs/guide/workspaces

export default defineWorkspace([
	{
		name: 'graphx',
		root: 'packages/graphx',
		// One published package, many entry points — every entry below is reachable as a
		// `graphx/<subpath>` export (see the `exports` map in package.json). They stay SEPARATE
		// entries rather than one barrel so an optional peer is only pulled onto the import path
		// of a consumer who opted into that subpath: `pg` by `graphx/pg`, `@duckdb/node-api`
		// (~123MB installed) by `graphx/duck`, `@aws-sdk/client-s3` by `graphx/ingest/s3` and
		// `graphx/blob`, `@modelcontextprotocol/sdk` by `graphx/mcp`, and React + React Query by
		// `graphx/react`. A single bundled entry would drag all of them in for everyone.
		//
		// `dts.inferTypes` makes bunup EMIT declarations with TypeScript's compiler instead of
		// isolated declarations — the generic `createGraphHooks` return (the whole hook set)
		// can't be expressed under isolated declarations, so without this the published `.d.ts`
		// for `graphx/react` collapses it to `{}`.
		config: {
			entry: [
				'src/core/index.ts',
				'src/core/portable.ts',
				'src/core/browser.ts',
				'src/core/expo.ts',
				'src/core/local.ts',
				'src/core/bunql.ts',
				'src/core/pg.ts',
				'src/core/duck.ts',
				'src/core/blob.ts',
				'src/embedders/index.ts',
				'src/jev/index.ts',
				'src/react/index.ts',
				'src/mcp/index.ts',
				'src/ingest/index.ts',
				'src/ingest/s3.ts',
				'src/auth/index.ts',
			],
			sourceBase: './src',
			// One build shares public classes across core, native and adapter entries.
			// Browser conditions select ulidx's portable implementation; native builtins
			// stay external and are reachable only through the native/server entry graph.
			target: 'browser',
			external: ['node:*'],
			noExternal: ['ulidx', 'layerr'],
			// Share declarations too: duplicated Graph private members break assignability.
			dts: { inferTypes: true, splitting: true },
		},
	},
	{
		// The `graphx` executable, built separately ONLY so the shebang banner lands on it and
		// not on every library entry above. `mcp/bin.ts` needs no entry of its own: `graphx mcp`
		// reaches it by dynamic import, so it is pulled into this graph as a lazy chunk.
		//
		// `clean: false` is load-bearing: this group shares `packages/graphx/dist` with the group
		// above, and bunup cleans the output directory by default — so a cleaning second pass
		// deletes everything the first pass just wrote and ships a package whose `exports` map
		// points at missing files.
		name: 'graphx-bin',
		root: 'packages/graphx',
		config: {
			entry: ['src/cli.ts'],
			banner: '#!/usr/bin/env bun',
			sourceBase: './src',
			clean: false,
			dts: { inferTypes: true },
		},
	},
]);
