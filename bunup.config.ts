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
			entry: ['src/index.ts', 'src/pg.ts'],
		},
	},
]);
