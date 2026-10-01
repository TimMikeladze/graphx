import { searchFighters } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

/** Full-text fighter search. */
export async function GET(req: Request) {
	const { graph } = await mma();
	const q = new URL(req.url).searchParams.get('q') ?? '';
	return Response.json({ results: await searchFighters(graph, q) });
}
