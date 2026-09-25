import type { GraphEvent } from '../core/events.ts';
import type { Graph, GraphSchema } from '../core/graph.ts';
import type { TriggerCondition } from '../core/triggers.ts';
import { type Jev, type JevOptions, type JsonValue, noul, type NoulQuestion } from './client.ts';
import { jevOf, nodeView } from './util.ts';

/**
 * A trigger condition on meaning rather than shape: `when: jevCondition('Does this alert
 * describe customer-facing downtime?')`. It reads the node the event is about (or both
 * endpoints of an edge) as it stood at the event, and fires when the yes reaches `min`.
 */

export interface JevConditionOptions<S extends GraphSchema> {
	/** Fire when the noul reaches this. Default 0.5. */
	min?: number;
	/** Build the state yourself. Default: the event plus the node (or edge endpoints) it touched. */
	state?: (event: GraphEvent, graph: Graph<S>) => Promise<JsonValue> | JsonValue;
	jev?: Jev | JevOptions;
}

/** The state `jevCondition` reads for an event by default. */
export async function eventState<S extends GraphSchema>(
	event: GraphEvent,
	graph: Graph<S>,
): Promise<JsonValue> {
	// A close removed the live version; read the one it closed.
	const asOf = event.shape === 'close' ? event.ts - 1 : event.ts;
	const view = async (id: string) => {
		const v = await graph.getNodeVersion(id, { asOf });
		return v ? nodeView(v) : null;
	};
	const head = { op: event.op, label: event.label };
	if (event.entity === 'node') return { event: head, node: await view(event.id) };
	return {
		event: head,
		edge: {
			rel: event.label,
			src: event.src ? await view(event.src) : null,
			dst: event.dst ? await view(event.dst) : null,
		},
	};
}

/** A `when` for a trigger, asked of Jev. A failed request throws, so the runner retries it. */
export function jevCondition<S extends GraphSchema>(
	question: string | NoulQuestion,
	opts: JevConditionOptions<S> = {},
): TriggerCondition<S> {
	const jev = jevOf(opts.jev);
	const q = typeof question === 'string' ? noul(question) : question;
	const min = opts.min ?? 0.5;
	return async (event, graph) => {
		const state = await (opts.state ?? eventState)(event, graph);
		return (await jev.ask(state, { fires: q })).answers.fires.noul >= min;
	};
}
