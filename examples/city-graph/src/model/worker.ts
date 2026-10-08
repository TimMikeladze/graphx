/// <reference lib="webworker" />
/**
 * One traffic-assignment worker: loads the prepared city once, then assigns whatever windows it
 * is sent. Windows are independent (each is solved from scratch), so a day parallelises cleanly.
 */
import { readModelInputs } from '../prepare.ts';
import { assign } from './assign.ts';
import { buildModel, type CityModel, type Edits } from './city.ts';
import { iterationsFor, WINDOWS, windowDemand } from './demand.ts';

declare const self: Worker;

let model: CityModel | null = null;

export interface WorkerInit {
	kind: 'init';
	prepared: string;
	edits: Edits;
}
export interface WorkerJob {
	kind: 'window';
	index: number;
}
export interface WorkerResult {
	index: number;
	volume: Float64Array;
	seconds: Float64Array;
	gap: number;
}

self.onmessage = async (e: MessageEvent<WorkerInit | WorkerJob>) => {
	const msg = e.data;
	if (msg.kind === 'init') {
		model = buildModel(await readModelInputs(msg.prepared), msg.edits);
		self.postMessage({ ready: true });
		return;
	}
	const w = WINDOWS[msg.index]!;
	const a = assign(model!.net, windowDemand(model!.ods, w), { iterations: iterationsFor(w) });
	const out: WorkerResult = { index: msg.index, volume: a.volume, seconds: a.seconds, gap: a.gap };
	self.postMessage(out, [a.volume.buffer, a.seconds.buffer]);
};
