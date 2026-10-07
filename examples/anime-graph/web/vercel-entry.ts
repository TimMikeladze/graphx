// Bundled to `.deploy/api/index.js` by `build.ts`; Vercel calls `fetch` for every /api/* route.
import { handle } from './api.ts';

export default { fetch: handle };
