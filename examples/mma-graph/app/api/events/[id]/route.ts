import { getEvent } from '@/src/server/queries';
import { mma } from '@/src/server/runtime';

export const dynamic = 'force-dynamic';

/** An event's card + results. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const { graph } = await mma();
	const event = await getEvent(graph, id);
	if (!event) return Response.json({ error: 'event not found' }, { status: 404 });
	return Response.json(event);
}
