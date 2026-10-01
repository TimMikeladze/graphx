import { getHead2Head } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

/** Pair history. */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const a = url.searchParams.get('a');
	const b = url.searchParams.get('b');
	if (!a || !b) return Response.json({ error: 'a and b required' }, { status: 400 });
	const { graph } = await mma();
	const h2h = await getHead2Head(graph, a, b);
	if (!h2h) return Response.json({ error: 'fighter not found' }, { status: 404 });
	return Response.json(h2h);
}
