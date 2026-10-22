import { expect, test } from 'bun:test';
import { decodeVehicles } from '../src/rt.ts';

// A tiny protobuf writer, enough to build a GTFS-rt FeedMessage by hand.
const varint = (n: number) => {
	const out: number[] = [];
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	out.push(n);
	return out;
};
const bytes = (n: number, b: number[]) => [...varint((n << 3) | 2), ...varint(b.length), ...b];
const str = (n: number, s: string) => bytes(n, [...new TextEncoder().encode(s)]);
const int = (n: number, v: number) => [...varint(n << 3), ...varint(v)];
const f32 = (n: number, v: number) => {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setFloat32(0, v, true);
	return [...varint((n << 3) | 5), ...b];
};

test('decodeVehicles reads trip, route, position, stop and vehicle id', () => {
	const vehicle = [
		...bytes(1, [...str(1, '562519881'), ...str(5, '100001'), ...int(6, 1)]),
		...bytes(2, [...f32(1, 47.6267), ...f32(2, -122.3615), ...f32(3, 90)]),
		...int(4, 1),
		...int(5, 1_792_710_201),
		...str(7, '2140'),
		...bytes(8, [...str(1, '4301'), ...str(2, '4301')]),
	];
	const feed = new Uint8Array([
		...bytes(1, [...str(1, '2.0')]),
		...bytes(2, [...str(1, 'e1'), ...bytes(4, vehicle)]),
		...bytes(2, [...str(1, 'e2')]), // an entity without a vehicle is skipped
	]);
	const [v, ...rest] = decodeVehicles(feed);
	expect(rest).toEqual([]);
	expect(v).toMatchObject({
		id: '4301',
		trip: '562519881',
		route: '100001',
		direction: 1,
		stop: '2140',
		status: 'stopped',
		timestamp: 1_792_710_201,
	});
	expect(v!.lat).toBeCloseTo(47.6267, 3);
	expect(v!.lng).toBeCloseTo(-122.3615, 3);
});
