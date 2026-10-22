/**
 * Live bus positions from King County Metro's GTFS-realtime feed. Positions go to the map and
 * are never stored. The feed is protobuf; this reads the handful of VehiclePosition fields the
 * map uses with a small wire-format decoder rather than a protobuf runtime.
 */

export const VEHICLES_URL = 'https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb';

export interface Vehicle {
	id: string;
	label: string;
	trip: string;
	route: string;
	direction: number | null;
	lat: number;
	lng: number;
	bearing: number | null;
	stop: string;
	status: 'incoming' | 'stopped' | 'transit';
	timestamp: number; // epoch seconds
}

type Field = { n: number; wire: number; v: number | bigint | Uint8Array };

function* fields(buf: Uint8Array): Generator<Field> {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let i = 0;
	const varint = (): bigint => {
		let out = 0n;
		let shift = 0n;
		for (;;) {
			const b = buf[i++]!;
			out |= BigInt(b & 0x7f) << shift;
			if (b < 0x80) return out;
			shift += 7n;
		}
	};
	while (i < buf.length) {
		const key = Number(varint());
		const n = key >>> 3;
		const wire = key & 7;
		if (wire === 0) yield { n, wire, v: varint() };
		else if (wire === 1) {
			yield { n, wire, v: view.getFloat64(i, true) };
			i += 8;
		} else if (wire === 2) {
			const len = Number(varint());
			yield { n, wire, v: buf.subarray(i, i + len) };
			i += len;
		} else if (wire === 5) {
			yield { n, wire, v: view.getFloat32(i, true) };
			i += 4;
		} else throw new Error(`unsupported wire type ${wire}`);
	}
}

const text = new TextDecoder();
const str = (v: Field['v']) => text.decode(v as Uint8Array);
const STATUS = ['incoming', 'stopped', 'transit'] as const;

/** Decode a GTFS-rt `FeedMessage` into the vehicles it carries. */
export function decodeVehicles(buf: Uint8Array): Vehicle[] {
	const out: Vehicle[] = [];
	for (const entity of fields(buf)) {
		if (entity.n !== 2) continue; // FeedMessage.entity
		for (const ef of fields(entity.v as Uint8Array)) {
			if (ef.n !== 4) continue; // FeedEntity.vehicle
			const v: Vehicle = {
				id: '',
				label: '',
				trip: '',
				route: '',
				direction: null,
				lat: Number.NaN,
				lng: Number.NaN,
				bearing: null,
				stop: '',
				status: 'transit',
				timestamp: 0,
			};
			for (const f of fields(ef.v as Uint8Array)) {
				if (f.n === 1)
					for (const t of fields(f.v as Uint8Array)) {
						if (t.n === 1) v.trip = str(t.v);
						else if (t.n === 5) v.route = str(t.v);
						else if (t.n === 6) v.direction = Number(t.v);
					}
				else if (f.n === 2)
					for (const p of fields(f.v as Uint8Array)) {
						if (p.n === 1) v.lat = Number(p.v);
						else if (p.n === 2) v.lng = Number(p.v);
						else if (p.n === 3) v.bearing = Number(p.v);
					}
				else if (f.n === 4) v.status = STATUS[Number(f.v)] ?? 'transit';
				else if (f.n === 5) v.timestamp = Number(f.v);
				else if (f.n === 7) v.stop = str(f.v);
				else if (f.n === 8)
					for (const d of fields(f.v as Uint8Array)) {
						if (d.n === 1) v.id = str(d.v);
						else if (d.n === 2) v.label = str(d.v);
					}
			}
			if (Number.isFinite(v.lat) && Number.isFinite(v.lng)) out.push(v);
		}
	}
	return out;
}

export async function fetchVehicles(fetcher: typeof fetch = fetch): Promise<Vehicle[]> {
	const res = await fetcher(VEHICLES_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
	if (!res.ok) throw new Error(`vehicle feed ${res.status}`);
	return decodeVehicles(new Uint8Array(await res.arrayBuffer()));
}
