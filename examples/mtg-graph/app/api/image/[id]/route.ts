import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const face = new URL(request.url).searchParams.get('face') ?? 'front';
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) ||
		!['front', 'back'].includes(face)
	)
		return new Response('Invalid image identifier', { status: 400 });
	const directory = join(process.cwd(), 'data', 'card-images');
	const path = join(directory, `${id}-${face}.jpg`);
	let bytes: Uint8Array;
	try {
		bytes = await readFile(path);
	} catch {
		const response = await fetch(
			`https://cards.scryfall.io/normal/${face}/${id[0]}/${id[1]}/${id}.jpg`,
			{
				signal: AbortSignal.timeout(10000),
				headers: { 'User-Agent': 'CardDataClient/1.0', Accept: 'image/jpeg' },
			},
		);
		if (!response.ok) return new Response('Image unavailable', { status: 404 });
		bytes = new Uint8Array(await response.arrayBuffer());
		await mkdir(directory, { recursive: true });
		await writeFile(path, bytes);
	}
	return new Response(bytes as BodyInit, {
		headers: {
			'Content-Type': 'image/jpeg',
			'Cache-Control': 'public, max-age=86400',
			'X-Content-Type-Options': 'nosniff',
		},
	});
}
