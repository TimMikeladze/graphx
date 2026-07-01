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
	const gateways = g.useListNodes({ kind: 'gateway' }); // rows: NodeOf<Schema,'gateway'>[]
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
						{gw.props.name} <small style={{ color: gw.props.online ? '#2a2' : '#c33' }}>
							{gw.props.online ? 'online' : 'offline'}
						</small>{' '}
						<small style={{ color: '#888' }}>fw {gw.props.firmware}</small>
					</div>
				))}
		</div>
	);
}

function GatewayDetail({ id }: { id: string }) {
	const gw = g.useNode(id, 'gateway'); // NodeOf<Schema,'gateway'> | null
	const site = g.useNeighbors(id, { rel: 'deployedAt' }); // site[] (deployedAt.to = site)
	const devices = g.useNeighbors(id, { rel: 'connectedTo', direction: 'reverse' }); // device[] (from = device)
	// devices → the alerts raised on them, typed per alias
	const alerts = g.useMatch({
		steps: [
			{ node: { alias: 'd', kind: 'device' } },
			{ edge: { rel: 'raised', direction: 'in' } },
			{ node: { alias: 'a', kind: 'alert' } },
		],
		select: ['d', 'a'],
	});

	if (gw.isLoading) return <p>…</p>;
	if (!gw.data) return <p>Not found.</p>;
	return (
		<div>
			<h2>
				{gw.data.props.name}{' '}
				<small style={{ color: gw.data.props.online ? '#2a2' : '#c33' }}>
					{gw.data.props.online ? 'online' : 'offline'}
				</small>
			</h2>
			<p>Site: {site.data?.pages[0]?.rows[0]?.props.name ?? '—'} · firmware {gw.data.props.firmware}</p>
			<h4>Connected devices</h4>
			<ul>
				{devices.data?.pages
					.flatMap((p) => p.rows)
					.map((d) => (
						<li key={d.id}>
							{d.props.name} — {d.props.category} ({d.props.model})
						</li>
					))}
			</ul>
			<h4>Alerts on devices (fleet-wide)</h4>
			<ul>
				{alerts.data?.rows.map(({ d, a }) => (
					<li key={a.id}>
						{a.props.code} [{a.props.severity}] → {d.props.name}
					</li>
				))}
			</ul>
		</div>
	);
}

function AlertFeed() {
	g.useChangeFeedSync({ intervalMs: 3000 }); // tail /changes → invalidate affected keys
	const alerts = g.useListNodes({ kind: 'alert' }); // alert[]
	const ack = g.useUpdateNode();
	const rank = { critical: 0, warning: 1, info: 2 } as const;
	return (
		<div>
			<h3>Alerts (live)</h3>
			{alerts.data?.pages
				.flatMap((p) => p.nodes)
				.sort((a, b) => rank[a.props.severity] - rank[b.props.severity])
				.map((a) => (
					<div key={a.id} style={{ marginBottom: 8 }}>
						<b>{a.props.code}</b> [{a.props.severity}] — {a.props.status}{' '}
						{a.props.status === 'open' && (
							<button
								type="button"
								onClick={() => ack.mutate({ id: a.id, patch: { props: { status: 'ack' } } })}
							>
								ack
							</button>
						)}
					</div>
				))}
		</div>
	);
}
