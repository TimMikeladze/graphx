import { getFighter } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

/** Bio + career + `derived` win stats. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const { graph } = await mma();
	const fighter = await getFighter(graph, id);
	if (!fighter) return Response.json({ error: 'fighter not found' }, { status: 404 });
	return Response.json(fighter);
}
