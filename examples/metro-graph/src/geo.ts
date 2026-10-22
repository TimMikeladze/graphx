type P = [lng: number, lat: number];

/** Metres between two [lng, lat] points. */
export function haversine(a: P, b: P): number {
	const r = Math.PI / 180;
	const dLat = (b[1] - a[1]) * r;
	const dLng = (b[0] - a[0]) * r;
	const h =
		Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
	return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

/** Douglas–Peucker on an equirectangular projection; `tolerance` in metres. */
export function simplify(line: P[], tolerance: number): P[] {
	if (line.length < 3) return line;
	const lat0 = (line[0]![1] * Math.PI) / 180;
	const kx = 111_320 * Math.cos(lat0);
	const ky = 110_540;
	const xy = line.map(([x, y]) => [x * kx, y * ky] as const);
	const keep = new Uint8Array(line.length);
	keep[0] = keep[line.length - 1] = 1;
	const stack: Array<[number, number]> = [[0, line.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		const [ax, ay] = xy[a]!;
		const [bx, by] = xy[b]!;
		const dx = bx - ax;
		const dy = by - ay;
		const len = Math.hypot(dx, dy) || 1;
		let best = -1;
		let dist = 0;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = xy[i]!;
			const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
			if (d > dist) {
				dist = d;
				best = i;
			}
		}
		if (best !== -1 && dist > tolerance) {
			keep[best] = 1;
			stack.push([a, best], [best, b]);
		}
	}
	return line.filter((_, i) => keep[i]);
}
