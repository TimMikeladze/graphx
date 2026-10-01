import { getStats } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

/** Corpus counts + the newest fights, for the dashboard. */
export async function GET(req: Request) {
	const { graph } = await mma();
	const recent = new URL(req.url).searchParams.get('recent');
	return Response.json(await getStats(graph, Number(recent ?? 12)));
}
