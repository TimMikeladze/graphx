/** Small geometry helpers — WGS84 lng/lat, metres. No dependency: Boston is small and flat enough. */

export type LngLat = [lng: number, lat: number];
export type Ring = LngLat[];
export type Polygon = Ring[];

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LngLat, b: LngLat): number {
	const dLat = rad(b[1] - a[1]);
	const dLng = rad(b[0] - a[0]);
	const h =
		Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

/** Length of a polyline in metres. */
export function lineLength(coords: LngLat[]): number {
	let m = 0;
	for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1]!, coords[i]!);
	return m;
}

function inRing(p: LngLat, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i]!;
		const [xj, yj] = ring[j]!;
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
			inside = !inside;
	}
	return inside;
}

/** Point in a polygon with holes (first ring outer, the rest holes). */
export function inPolygon(p: LngLat, poly: Polygon): boolean {
	if (!poly[0] || !inRing(p, poly[0])) return false;
	for (let i = 1; i < poly.length; i++) if (inRing(p, poly[i]!)) return false;
	return true;
}

/** GeoJSON Polygon | MultiPolygon geometry → list of polygons. */
export function polygonsOf(geometry: { type: string; coordinates: unknown }): Polygon[] {
	if (geometry.type === 'Polygon') return [geometry.coordinates as Polygon];
	if (geometry.type === 'MultiPolygon') return geometry.coordinates as Polygon[];
	return [];
}

/** Area-weighted centroid of a polygon set (outer rings; fine for census block groups). */
export function centroid(polys: Polygon[]): LngLat {
	let ax = 0;
	let ay = 0;
	let aa = 0;
	for (const poly of polys) {
		const ring = poly[0] ?? [];
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [x0, y0] = ring[j]!;
			const [x1, y1] = ring[i]!;
			const f = x0 * y1 - x1 * y0;
			ax += (x0 + x1) * f;
			ay += (y0 + y1) * f;
			aa += f;
		}
	}
	if (aa === 0) {
		const ring = polys[0]?.[0] ?? [[0, 0]];
		return ring[0] as LngLat;
	}
	return [ax / (3 * aa), ay / (3 * aa)];
}

/** Bounding box [minLng, minLat, maxLng, maxLat]. */
export type BBox = [number, number, number, number];

export function inBBox(p: LngLat, b: BBox): boolean {
	return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

/**
 * A uniform grid over points for nearest-neighbour lookups. Cells are ~`cellM` metres; a query
 * searches outward ring by ring until the best hit is provably nearest or `maxM` is exceeded.
 */
export class GridIndex<T> {
	private cells = new Map<string, Array<{ p: LngLat; v: T }>>();
	private all: Array<{ p: LngLat; v: T }> = [];
	private readonly dLat: number;
	private readonly dLng: number;

	constructor(
		items: Iterable<{ p: LngLat; v: T }>,
		private readonly cellM = 200,
	) {
		this.dLat = cellM / 111_320;
		this.dLng = cellM / (111_320 * Math.cos(rad(42.33)));
		for (const it of items) {
			this.all.push(it);
			const k = this.key(this.cell(it.p));
			const list = this.cells.get(k);
			if (list) list.push(it);
			else this.cells.set(k, [it]);
		}
	}

	private cell(p: LngLat): [number, number] {
		return [Math.floor(p[0] / this.dLng), Math.floor(p[1] / this.dLat)];
	}

	private key([x, y]: [number, number]): string {
		return `${x}:${y}`;
	}

	/** The `k` nearest distinct items, nearest first (a linear scan — fine for a few thousand). */
	nearestK(p: LngLat, k: number, accept?: (v: T) => boolean): Array<{ v: T; d: number }> {
		const near = this.nearest(p, Number.POSITIVE_INFINITY, accept);
		if (!near) return [];
		// Search a disc a little wider than the nearest hit, then rank.
		const radius = Math.max(near.d * 1.5, near.d + 600);
		const hits: Array<{ v: T; d: number }> = [];
		for (const it of this.all) {
			if (accept && !accept(it.v)) continue;
			const d = haversine(p, it.p);
			if (d <= radius) hits.push({ v: it.v, d });
		}
		return hits.sort((a, b) => a.d - b.d).slice(0, k);
	}

	/** Nearest item within `maxM` metres, or null. */
	nearest(
		p: LngLat,
		maxM = Number.POSITIVE_INFINITY,
		accept?: (v: T) => boolean,
	): { v: T; d: number } | null {
		const [cx, cy] = this.cell(p);
		let best = null as { v: T; d: number } | null;
		const maxRing = Number.isFinite(maxM) ? Math.ceil(maxM / this.cellM) + 1 : 25;
		for (let r = 0; r <= maxRing; r++) {
			for (let x = cx - r; x <= cx + r; x++) {
				for (let y = cy - r; y <= cy + r; y++) {
					if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
					for (const it of this.cells.get(this.key([x, y])) ?? []) {
						if (accept && !accept(it.v)) continue;
						const d = haversine(p, it.p);
						if (d <= maxM && (!best || d < best.d)) best = { v: it.v, d };
					}
				}
			}
			// Everything in ring r+1 is at least r·cellM away.
			if (best && best.d <= r * this.cellM) return best;
		}
		if (best || Number.isFinite(maxM)) return best;
		// Far outside the indexed area (a tract 100 km away): a linear scan beats walking rings.
		let far: { v: T; d: number } | null = null;
		for (const it of this.all) {
			if (accept && !accept(it.v)) continue;
			const d = haversine(p, it.p);
			if (!far || d < far.d) far = { v: it.v, d };
		}
		return far;
	}
}
