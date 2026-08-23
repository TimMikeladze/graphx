import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { evict } from '../../src/core/db.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { createApp } from '../../src/core/serve.ts';

// Eventing Layer 3 — the SSE /events route. Pushes the durable outbox tail (delete-INCLUSIVE,
// unlike /changes) as `event: <op>` / `data: <GraphEvent>` / `id: <seq>` frames. Requires the
// outbox. Driven in-process via app.request (a streaming Response) — no server/port.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }), device: z.object({ kind: z.string() }) },
	edges: { owns: { from: 'person', to: 'device' } },
});

function cleanup(control: { close: () => void }, db: string): void {
	control.close();
	evict(db);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });
}

interface Frame {
	event?: string;
	id?: string;
	data?: unknown;
}

/**
 * Read SSE frames from a streaming Response until `want` non-ping frames arrive or the timeout
 * aborts the (otherwise infinite) stream. Aborting the signal makes the server loop exit cleanly.
 */
async function readFrames(
	res: Response,
	want: number,
	ac: AbortController,
	timeoutMs = 8000,
): Promise<Frame[]> {
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const dec = new TextDecoder();
	const out: Frame[] = [];
	let buf = '';
	try {
		while (out.length < want) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let idx: number;
			while ((idx = buf.indexOf('\n\n')) !== -1) {
				const raw = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const f: Frame = {};
				let data = '';
				for (const line of raw.split('\n')) {
					if (line.startsWith('event:')) f.event = line.slice(6).trim();
					else if (line.startsWith('id:')) f.id = line.slice(3).trim();
					else if (line.startsWith('data:')) data += line.slice(5).trim();
				}
				if (f.event === 'ping') continue; // keep-alive
				f.data = data ? JSON.parse(data) : undefined;
				out.push(f);
			}
		}
	} catch {
		/* aborted / stream closed — return what we have */
	} finally {
		clearTimeout(timer);
		ac.abort();
		await reader.cancel().catch(() => {});
	}
	return out;
}

async function post(
	app: { request: (i: string, init?: RequestInit) => Promise<Response> },
	path: string,
	body: unknown,
): Promise<Response> {
	return app.request(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

test('GET /events (since=beginning) replays the outbox including deletes', async () => {
	const db = `evt_${ulid()}`;
	const { app, control, tenant, project } = await createApp({
		schema: SCHEMA,
		db,
		events: { outbox: true },
	});
	const base = `/t/${tenant}/p/${project}`;
	try {
		const p = (await (
			await post(app, `${base}/nodes`, { type: 'person', data: { name: 'a' } })
		).json()) as { id: string };
		const d = (await (
			await post(app, `${base}/nodes`, { type: 'device', data: { kind: 'x' } })
		).json()) as { id: string };
		const e = (await (
			await post(app, `${base}/edges`, { rel: 'owns', src: p.id, dst: d.id })
		).json()) as { id: string };
		await app.request(`${base}/edges/${e.id}`, { method: 'DELETE' });

		const ac = new AbortController();
		const res = await app.request(`${base}/events?since=beginning`, { signal: ac.signal });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');

		const frames = await readFrames(res, 4, ac);
		const ops = frames.map((f) => f.event);
		expect(ops).toEqual(['node.create', 'node.create', 'edge.create', 'edge.delete']);
		// The delete the /changes feed can NEVER surface — here as a first-class frame with endpoints.
		expect(frames[3]?.data).toMatchObject({
			op: 'edge.delete',
			id: e.id,
			shape: 'close',
			src: p.id,
			dst: d.id,
		});
		// Frames carry the monotonic seq as the SSE id (the resume cursor).
		expect(frames.every((f) => /^\d+$/.test(f.id ?? ''))).toBe(true);
	} finally {
		cleanup(control, db);
	}
});

test('GET /events pushes NEW events live (since=now)', async () => {
	const db = `evt_${ulid()}`;
	const { app, control, tenant, project } = await createApp({
		schema: SCHEMA,
		db,
		events: { outbox: true },
	});
	const base = `/t/${tenant}/p/${project}`;
	try {
		// Pre-existing event that since=now must NOT replay.
		await post(app, `${base}/nodes`, { type: 'person', data: { name: 'old' } });

		const ac = new AbortController();
		const res = await app.request(`${base}/events?since=now&poll=200`, { signal: ac.signal });
		const collect = readFrames(res, 1, ac);

		// Mutate AFTER connecting — the stream should push exactly this one.
		await post(app, `${base}/nodes`, { type: 'device', data: { kind: 'live' } });

		const frames = await collect;
		expect(frames).toHaveLength(1);
		expect(frames[0]?.event).toBe('node.create');
		expect(frames[0]?.data).toMatchObject({ label: 'device' });
	} finally {
		cleanup(control, db);
	}
});

test('GET /events is 501 when the outbox is not configured', async () => {
	const db = `evt_${ulid()}`;
	const { app, control, tenant, project } = await createApp({ schema: SCHEMA, db }); // no events.outbox
	try {
		const res = await app.request(`/t/${tenant}/p/${project}/events`);
		expect(res.status).toBe(501);
	} finally {
		cleanup(control, db);
	}
});
