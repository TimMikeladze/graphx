import { type GraphError } from 'graphx-react';
import { useState } from 'react';
import { g } from './hooks.ts';

export function App() {
	const [gateway, setGateway] = useState<string | null>(null);
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: '240px 1fr 320px',
				gap: 24,
				padding: 24,
				fontFamily: 'system-ui, sans-serif',
			}}
		>
			<GatewayList selected={gateway} onSelect={setGateway} />
			<div>{gateway ? <GatewayDetail id={gateway} /> : <p>Select a gateway.</p>}</div>
			<AlertFeed />
		</div>
	);
}

function GatewayList({
	selected,
	onSelect,
}: {
	selected: string | null;
	onSelect: (id: string) => void;
}) {
	const gateways = g.useListNodes({ type: 'gateway' }); // rows: NodeOf<Schema,'gateway'>[]

	return (
		<div>
			<h3>Gateways</h3>
			{gateways.data?.pages
				.flatMap((p) => p.nodes)
				.map((gw) => (
					<div
						key={gw.id}
						onClick={() => onSelect(gw.id)}
						style={{ cursor: 'pointer', fontWeight: selected === gw.id ? 700 : 400 }}
					>
						{gw.data.name}{' '}
						<small style={{ color: gw.data.online ? '#2a2' : '#c33' }}>
							{gw.data.online ? 'online' : 'offline'}
						</small>{' '}
						<small style={{ color: '#888' }}>fw {gw.data.firmware}</small>
					</div>
				))}
		</div>
	);
}

function GatewayDetail({ id }: { id: string }) {
	const gw = g.useNode(id, 'gateway'); // NodeOf<Schema,'gateway'> | null

	const site = g.useNeighbors(id, { rel: 'deployedAt' }); // site[] (deployedAt.to = site)
	const devices = g.useNeighbors(id, { rel: 'connectedTo', direction: 'reverse' }); // device[] (from = device)
	// devices → the alerts raised on them, typed per alias. Fluent builder form (type/rel-checked,
	// same per-alias row types as the object form): device <-[raised]- alert.
	const alerts = g.useMatch((q) =>
		q.node('d', 'device').in('raised').node('a', 'alert').select('d', 'a'),
	);

	if (gw.isLoading) return <p>…</p>;
	if (!gw.data) return <p>Not found.</p>;
	return (
		<div>
			<h2>
				{gw.data.data.name}{' '}
				<small style={{ color: gw.data.data.online ? '#2a2' : '#c33' }}>
					{gw.data.data.online ? 'online' : 'offline'}
				</small>
			</h2>
			<p>
				Site: {site.data?.pages[0]?.rows[0]?.data.name ?? '—'} · firmware {gw.data.data.firmware}
			</p>
			<h4>Connected devices</h4>
			<ul>
				{devices.data?.pages
					.flatMap((p) => p.rows)
					.map((d) => (
						<li key={d.id}>
							{d.data.name} — {d.data.category} ({d.data.model})
						</li>
					))}
			</ul>
			<h4>Alerts on devices (fleet-wide)</h4>
			<ul>
				{alerts.data?.rows.map(({ d, a }) => (
					<li key={a.id}>
						{a.data.code} [{a.data.severity}] → {d.data.name}
					</li>
				))}
			</ul>
		</div>
	);
}

function AlertFeed() {
	g.useChangeFeedSync({ intervalMs: 3000 }); // tail /changes → invalidate affected keys
	const alerts = g.useListNodes({ type: 'alert' }); // alert[]
	const ack = g.useUpdateNode();
	const rank = { critical: 0, warning: 1, info: 2 } as const;
	// GraphError carries a typed `code` (`'validation' | 'forbidden' | 'not_found' | …`) — switch on
	// it instead of parsing the message. A viewer (read-only) role would get `code: 'forbidden'` here.
	const ackErr = ack.error as GraphError | null;
	return (
		<div>
			<h3>Alerts (live)</h3>
			{ackErr && (
				<p style={{ color: '#c33' }}>
					ack failed [{ackErr.code}]: {ackErr.message}
				</p>
			)}
			{alerts.data?.pages
				.flatMap((p) => p.nodes)
				.sort((a, b) => rank[a.data.severity] - rank[b.data.severity])
				.map((a) => (
					<div key={a.id} style={{ marginBottom: 8 }}>
						<b>{a.data.code}</b> [{a.data.severity}] — {a.data.status}{' '}
						{a.data.status === 'open' && (
							<button
								type="button"
								onClick={() => ack.mutate({ id: a.id, patch: { data: { status: 'ack' } } })}
							>
								ack
							</button>
						)}
					</div>
				))}
		</div>
	);
}
