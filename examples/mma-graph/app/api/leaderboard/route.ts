import { getLeaderboard } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

/** Top fighters by a derived metric. */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const metric = url.searchParams.get('metric') ?? 'wins';
	const limit = Number(url.searchParams.get('limit') ?? 25);
	const { graph } = await mma();
	try {
		return Response.json(await getLeaderboard(graph, metric, limit));
	} catch (e) {
		// Unknown metric — the query layer is the validator.
		return Response.json({ error: e instanceof Error ? e.message : 'bad metric' }, { status: 400 });
	}
}
