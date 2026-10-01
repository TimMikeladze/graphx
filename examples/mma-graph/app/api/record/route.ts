import { getRecord } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

/** Time travel: the fighter's record exactly as it stood on `asOf` (ISO date). */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const id = url.searchParams.get('id');
	const asOf = url.searchParams.get('asOf') ?? undefined;
	if (!id) return Response.json({ error: 'id required' }, { status: 400 });
	const { graph } = await mma();
	const record = await getRecord(graph, id, asOf);
	if (!record) return Response.json({ error: 'fighter not found' }, { status: 404 });
	return Response.json(record);
}
