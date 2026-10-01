import { getFighterFights } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

/** Chronological fight list with opponents and outcomes. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const { graph } = await mma();
	const fights = await getFighterFights(graph, id);
	if (!fights) return Response.json({ error: 'fighter not found' }, { status: 404 });
	return Response.json(fights);
}
