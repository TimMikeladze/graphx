import { buildCatalog } from './src/library';
import { existsSync } from 'node:fs';
import { runtime } from './src/runtime';
if (existsSync('data/manifest.json'))
	console.log(JSON.stringify(await buildCatalog(process.cwd()), null, 2));
const r = await runtime(true);
console.log(JSON.stringify(await r.status(), null, 2));
await r.db.close();
