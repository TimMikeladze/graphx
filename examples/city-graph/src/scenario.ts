import { createProject, type DbClient, getDb, type Graph, init } from 'graphx';
import { ulid } from 'ulidx';
import { embedder, type Schema } from '../schema.ts';
import { analyze } from './analyze.ts';
import { BEFORE_DAY, type DayIds, type DayStats, writeDay } from './day.ts';
import { dropLocal } from './load.ts';
import type { Edits } from './model/city.ts';
import type { Prepared } from './prepare.ts';

/**
 * A scenario is a fork. The city is branched as it stood the moment before the modelled day —
 * streets, zones, crashes, open 311 cases, buses, but none of the day's traffic — and the day is
 * replayed in the branch with the edits applied. The baseline is never touched, every id
 * survives the fork, and the branch is registered as its own project in the control plane, so
 * every generated graphx route and React hook works against it unchanged.
 */

export interface ScenarioInput {
	title: string;
	edits: Edits;
}

export interface Hosting {
	control: DbClient;
	tenant: string;
	baseline: Graph<Schema>;
	prepared: Prepared;
	preparedDir: string;
	ids: DayIds;
}

export interface ScenarioRun {
	id: string;
	namespace: string;
	done: Promise<{ stats: DayStats; branch: Graph<Schema> }>;
}

/** Start a scenario. Returns at once with the scenario node's id; `done` settles when written. */
export async function startScenario(h: Hosting, input: ScenarioInput): Promise<ScenarioRun> {
	const namespace = `city__scn_${ulid().toLowerCase()}`;
	const node = await h.baseline.addNode({
		type: 'scenario',
		data: {
			title: input.title,
			namespace,
			project: '',
			edits: input.edits as Record<string, unknown>,
			status: 'running',
			progress: 0,
			summary: null,
		},
	});
	const setProgress = (
		progress: number,
		extra: Partial<Schema['nodes']['scenario']['_output']> = {},
	) => h.baseline.updateNode(node.id, { data: { progress, ...extra } });

	const done = (async () => {
		try {
			dropLocal(namespace);
			const db = getDb(namespace);
			await init(db, embedder);
			const branch = await h.baseline.fork(db, { asOf: BEFORE_DAY });
			const project = await createProject(h.control, {
				tenantId: h.tenant,
				name: input.title,
				dbNamespace: namespace,
			});
			await setProgress(0.15, { project });

			// Signal retimings are real writes in the branch, so `history` on the intersection shows
			// the plan change and `diff` against the baseline lists it.
			for (const [key, plan] of Object.entries(input.edits.signals ?? {})) {
				const id = h.ids.intersection.get(key);
				const current = id ? await branch.getNode(id) : null;
				if (!current || current.type !== 'intersection') continue;
				const base = current.data.signal;
				await branch.updateNode(id!, {
					data: {
						signal: {
							cityId: base?.cityId ?? 0,
							name: base?.name ?? current.data.name,
							cycleSec: plan.cycleSec,
							green: plan.green,
							synthetic: true,
						},
					},
				});
			}

			let last = 0;
			const stats = await writeDay(branch, h.prepared, h.ids, {
				edits: input.edits,
				preparedDir: h.preparedDir,
				onProgress: (d, total) => {
					const p = 0.15 + 0.8 * (d / total);
					if (p - last > 0.04) {
						last = p;
						void setProgress(Math.round(p * 100) / 100);
					}
				},
			});
			// The branch gets its own rankings, so "critical intersections" can move with the edit.
			await analyze(branch);
			await setProgress(1, {
				status: 'done',
				summary: { vehicleHours: stats.vehicleHours, roadVersions: stats.roadVersions },
			});
			return { stats, branch };
		} catch (e) {
			await setProgress(1, {
				status: 'failed',
				summary: { error: String((e as Error).message ?? e) },
			});
			throw e;
		}
	})();
	done.catch(() => {});
	return { id: node.id, namespace, done };
}
