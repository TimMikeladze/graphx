'use client';
import { useState } from 'react';
import type { DeckRecord } from '@/src/schema';
import { Icon, Copy } from './ui';
export default function ApiConsole({ status, deck }: { status: any; deck: DeckRecord | null }) {
	const presets = [
		{
			name: 'Search cards',
			method: 'GET',
			path: '/api/v1/cards?q=t%3Acreature%20mv%3C%3D2&format=modern&limit=3',
		},
		{ name: 'Dataset status', method: 'GET', path: '/api/v1/status' },
		{ name: 'Catalog coverage', method: 'GET', path: '/api/v1/coverage' },
		{ name: 'All sets', method: 'GET', path: '/api/v1/library/sets?page=1&limit=50' },
		{ name: 'Published decks', method: 'GET', path: '/api/v1/library/decks?page=1&limit=50' },
		{
			name: 'Set printings',
			method: 'GET',
			path: '/api/v1/library/printings?set=MH3&page=1&limit=50',
		},
		{ name: 'Graph schema', method: 'GET', path: '/api/v1/schema' },
		{ name: 'Saved decks', method: 'GET', path: '/api/v1/decks' },
		{ name: 'Deck analysis', method: 'GET', path: `/api/v1/decks/${deck?.id ?? 'id'}/analysis` },
		{
			name: 'Draw probability',
			method: 'POST',
			path: '/api/v1/probability',
			body: JSON.stringify({ population: 60, successes: 4, draws: 7, minimum: 1 }, null, 2),
		},
	];
	const [method, setMethod] = useState('GET');
	const [path, setPath] = useState(presets[0]!.path);
	const [body, setBody] = useState('');
	const [response, setResponse] = useState('');
	const [http, setHttp] = useState<number | null>(null);
	const [elapsed, setElapsed] = useState(0);
	const [loading, setLoading] = useState(false);
	const run = async () => {
		setLoading(true);
		const start = performance.now();
		try {
			if (!path.startsWith('/api/v1/') || path.includes('..') || path.includes('://'))
				throw new Error('Use a local /api/v1/ endpoint');
			const r = await fetch(path, {
				method,
				headers: { 'Content-Type': 'application/json' },
				...(method === 'POST' ? { body } : {}),
			});
			setHttp(r.status);
			const json = await r.json();
			setResponse(JSON.stringify(json, null, 2));
			setElapsed(Math.round(performance.now() - start));
		} catch (e) {
			setHttp(null);
			setResponse((e as Error).message);
		} finally {
			setLoading(false);
		}
	};
	const curl = `curl '${typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8795'}${path}'${method === 'POST' ? ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${body.replaceAll("'", "'\\''")}'` : ''}`;
	return (
		<>
			<div className="page-heading">
				<div>
					<div className="eyebrow">WORKSPACE / DEVELOPER</div>
					<h1>
						API console<span className="heading-count">v1</span>
					</h1>
				</div>
				<a className="button" href="/api/openapi.json" target="_blank">
					<Icon name="code" />
					OpenAPI
					<Icon name="external" size={13} />
				</a>
			</div>
			<div className="api-layout">
				<aside className="api-sidebar">
					<div className="eyebrow">REQUESTS</div>
					{presets.map((p) => (
						<button
							className={path === p.path ? 'selected' : ''}
							key={p.name}
							onClick={() => {
								setPath(p.path);
								setMethod(p.method);
								setBody(p.body ?? '');
								setResponse('');
								setHttp(null);
							}}
						>
							<span className={`method ${p.method.toLowerCase()}`}>{p.method}</span>
							<span>{p.name}</span>
						</button>
					))}
					<div className="rail-divider" />
					<div className="api-dataset">
						<div className="eyebrow">DATASET</div>
						<p className="mono">{status?.dataset?.version ?? 'Loading…'}</p>
						<p>{status?.dataset?.cards?.toLocaleString()} cards</p>
						<p>{status?.edges?.toLocaleString()} graph edges</p>
						<span className="badge">Local single-user</span>
					</div>
				</aside>
				<section className="api-main">
					<div className="request-bar">
						<select
							aria-label="HTTP method"
							value={method}
							onChange={(e) => setMethod(e.target.value)}
						>
							<option>GET</option>
							<option>POST</option>
						</select>
						<input
							aria-label="API request path"
							value={path}
							onChange={(e) => setPath(e.target.value)}
							spellCheck={false}
						/>
						<button className="button dark" disabled={loading} onClick={run}>
							{loading ? 'Running…' : 'Send'}
							<Icon name="arrow" size={14} />
						</button>
					</div>
					{method === 'POST' && (
						<label className="field request-body">
							JSON body
							<textarea
								value={body}
								onChange={(e) => setBody(e.target.value)}
								rows={8}
								spellCheck={false}
							/>
						</label>
					)}
					<div className="code-panel">
						<div className="code-heading">
							<span>cURL</span>
							<Copy text={curl} />
						</div>
						<pre>{curl}</pre>
					</div>
					<div className="code-panel response-panel">
						<div className="code-heading">
							<span>Response{http !== null && <span className="badge">{http}</span>}</span>
							<span>
								{http !== null && <small className="mono muted">{elapsed} ms</small>}
								{response && <Copy text={response} />}
							</span>
						</div>
						{response ? (
							<pre tabIndex={0}>{response}</pre>
						) : (
							<div className="empty">
								<Icon name="code" size={24} />
								<p>Send a request to inspect the response.</p>
							</div>
						)}
					</div>
				</section>
			</div>
		</>
	);
}
