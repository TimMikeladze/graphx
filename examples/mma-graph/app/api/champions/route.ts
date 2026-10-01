import { getChampions, getReigns } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

/** Who held which belt on a date (or now). `reigns=1` returns full timelines per title. */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const asOf = url.searchParams.get('asOf') ?? undefined;
	const { graph } = await mma();
	if (url.searchParams.get('reigns') === '1') {
		return Response.json({ titles: await getReigns(graph) });
	}
	return Response.json({ asOf: asOf ?? null, champions: await getChampions(graph, asOf) });
}
