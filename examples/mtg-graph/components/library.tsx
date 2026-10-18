'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
	librarySections as sections,
	libraryHref,
	libraryListHref,
	readLibraryListState,
	type LibrarySection as Kind,
} from '@/src/library-navigation';
import { api, Empty, Icon } from './ui';

type Summary = {
	id: string;
	name: string;
	setCode?: string;
	type?: string;
	releaseDate?: string;
	cardCount?: number;
};
type Results = { items: Summary[]; total: number; page: number; limit: number; pages: number };
type Coverage = {
	complete: boolean;
	release: string | Record<string, unknown> | null;
	datasets: {
		name: string;
		expected: number | null;
		imported: number;
		complete: boolean;
		date?: string;
		sha256?: string;
	}[];
	counts: Record<string, number>;
	issues: unknown[];
};
const text = (value: unknown): string =>
	typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const label = (value: string) =>
	value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const number = (value: number | undefined | null) =>
	value == null ? 'Unknown' : value.toLocaleString();

export default function Library({ kind = 'sets' }: { kind?: Kind }) {
	const router = useRouter(),
		pathname = usePathname(),
		params = useSearchParams();
	const state = readLibraryListState(params);
	const { q: query, set, type, page, limit } = state;
	const update = (updates: Partial<typeof state>) =>
		window.history.replaceState(null, '', libraryListHref(kind, { ...state, ...updates }));
	const setQuery = (q: string) => update({ q, page: 1 });
	const setSet = (set: string) => update({ set, page: 1 });
	const setType = (type: string) => update({ type, page: 1 });
	const setPage = (page: number | ((previous: number) => number)) =>
		update({ page: typeof page === 'function' ? page(state.page) : page });
	const setLimit = (limit: number) => update({ limit, page: 1 });
	const returnTo = `${pathname}${params.size ? `?${params.toString()}` : ''}`;
	const [results, setResults] = useState<Results | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [retry, setRetry] = useState(0);
	const [coverage, setCoverage] = useState<Coverage | null>(null);
	const [coverageError, setCoverageError] = useState('');
	useEffect(() => {
		let active = true;
		api<Coverage>('/coverage')
			.then((data) => {
				if (active) {
					setCoverage(data);
					setCoverageError('');
				}
			})
			.catch((e) => {
				if (active) setCoverageError(e.message);
			});
		return () => {
			active = false;
		};
	}, [retry]);
	useEffect(() => {
		if (kind === 'coverage') {
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError('');
		setResults(null);
		const timer = setTimeout(() => {
			const params = new URLSearchParams({
				q: query,
				set,
				type,
				page: String(page),
				limit: String(limit),
			});
			api<Results>(`/library/${kind}?${params}`, { signal: controller.signal })
				.then((data) => {
					if (!controller.signal.aborted) setResults(data);
				})
				.catch((e) => {
					if (!controller.signal.aborted) setError(e.message);
				})
				.finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
		}, 200);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [kind, query, set, type, page, limit, retry]);
	const navigate = (next: Kind, setCode = '') =>
		router.push(libraryListHref(next, { set: setCode }));
	const title = sections.find(([id]) => id === kind)![1];
	return (
		<div className="library">
			<div className="page-heading">
				<div>
					<span className="eyebrow">MTGJSON catalog</span>
					<h1>Library</h1>
					<p className="page-description">
						Browse sets, published decks and every installed source record. Your saved decks stay in
						Decks.
					</p>
				</div>
				<button className="button" onClick={() => navigate('coverage')}>
					<Icon name="database" />
					{coverage
						? coverage.complete
							? 'Complete catalog'
							: 'Partial catalog'
						: 'Check coverage'}
				</button>
			</div>
			<div className="library-navigation">
				<label className="library-kind">
					Browse
					<select value={kind} onChange={(e) => navigate(e.target.value as Kind)}>
						{sections.map(([id, name]) => (
							<option key={id} value={id}>
								{name}
							</option>
						))}
					</select>
				</label>
				<div className="library-section-title">
					<h2>{title}</h2>
					{kind !== 'coverage' && results && (
						<span className="badge mono">{number(results.total)} records</span>
					)}
				</div>
			</div>
			{kind === 'coverage' ? (
				<CoverageView
					coverage={coverage}
					error={coverageError}
					onRetry={() => setRetry((n) => n + 1)}
				/>
			) : (
				<>
					<form className="library-filters" onSubmit={(e) => e.preventDefault()} role="search">
						<label className="library-search">
							<Icon name="search" />
							<input
								aria-label={`Search ${title.toLowerCase()}`}
								placeholder={`Search ${title.toLowerCase()} by name or ID…`}
								value={query}
								onChange={(e) => {
									setQuery(e.target.value);
								}}
							/>
						</label>
						{!['atomic', 'reference'].includes(kind) && (
							<input
								aria-label="Filter by set code"
								placeholder="Set code, e.g. MH3"
								value={set}
								onChange={(e) => {
									setSet(e.target.value);
								}}
							/>
						)}
						<input
							aria-label="Filter by type"
							placeholder="Type"
							value={type}
							onChange={(e) => {
								setType(e.target.value);
							}}
						/>
						{(query || set || type) && (
							<button
								className="button"
								onClick={() => {
									update({ q: '', set: '', type: '', page: 1 });
								}}
							>
								Clear filters
							</button>
						)}
					</form>
					{coverage && !coverage.complete && (
						<p className="library-partial">
							This catalog is partial.{' '}
							<button className="text-btn" onClick={() => navigate('coverage')}>
								View missing data
							</button>
						</p>
					)}
					<div aria-live="polite" aria-busy={loading}>
						{error ? (
							<div className="error-box" role="alert">
								{error}
								<button className="button small" onClick={() => setRetry((n) => n + 1)}>
									Retry
								</button>
							</div>
						) : loading ? (
							<div className="library-loading">Loading {title.toLowerCase()}…</div>
						) : results?.items.length ? (
							<div className="library-table-wrap">
								<table className="library-table">
									<thead>
										<tr>
											<th>Name</th>
											<th>Set</th>
											<th>Type</th>
											<th>Released</th>
											<th>Cards</th>
											<th>
												<span className="library-sr-only">Details</span>
											</th>
										</tr>
									</thead>
									<tbody>
										{results.items.map((item) => (
											<tr key={item.id}>
												<td>
													<Link
														className="library-record-name"
														href={libraryHref(kind, item.id, returnTo)}
														prefetch={false}
													>
														{item.name || item.id}
													</Link>
													<small className="library-record-id mono">{item.id}</small>
												</td>
												<td className="mono">{item.setCode || '—'}</td>
												<td>{item.type || '—'}</td>
												<td className="mono">{item.releaseDate || '—'}</td>
												<td className="mono">
													{item.cardCount == null ? '—' : number(item.cardCount)}
												</td>
												<td>
													<Link
														className="icon-btn"
														aria-label={`View ${item.name || item.id}`}
														href={libraryHref(kind, item.id, returnTo)}
														prefetch={false}
													>
														<Icon name="chevron" />
													</Link>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						) : (
							<Empty>
								<Icon name="book" size={28} />
								<h3>No {title.toLowerCase()} found</h3>
								<p>
									{query || set || type
										? 'Try another search or clear the filters.'
										: 'No records of this kind are installed. Coverage shows which datasets are missing.'}
								</p>
							</Empty>
						)}
					</div>
					<div className="library-pagination">
						<label>
							Rows per page{' '}
							<select
								aria-label="Library rows per page"
								value={limit}
								onChange={(e) => {
									setLimit(Number(e.target.value));
								}}
							>
								{[25, 50, 100].map((n) => (
									<option key={n}>{n}</option>
								))}
							</select>
						</label>
						<span className="muted">
							{results?.total
								? `${number((results.page - 1) * results.limit + 1)}–${number(Math.min(results.page * results.limit, results.total))} of ${number(results.total)}`
								: '0 records'}
						</span>
						<div className="button-group">
							<button
								className="button small"
								disabled={loading || page <= 1}
								onClick={() => setPage(1)}
							>
								First
							</button>
							<button
								className="button small"
								disabled={loading || page <= 1}
								onClick={() => setPage((n) => n - 1)}
							>
								Previous
							</button>
							<label className="library-page-count">
								<span className="library-sr-only">Go to page</span>
								<input
									key={page}
									type="number"
									min={1}
									max={Math.max(1, results?.pages ?? 1)}
									defaultValue={page}
									disabled={loading || !results?.total}
									onKeyDown={(e) => {
										if (e.key === 'Enter') e.currentTarget.blur();
									}}
									onBlur={(e) => {
										const next = Math.max(
											1,
											Math.min(results?.pages || 1, Math.trunc(Number(e.target.value)) || 1),
										);
										e.target.value = String(next);
										setPage(next);
									}}
								/>
								/ {Math.max(1, results?.pages ?? 1)}
							</label>
							<button
								className="button small"
								disabled={loading || !results || page >= results.pages}
								onClick={() => setPage((n) => n + 1)}
							>
								Next
							</button>
							<button
								className="button small"
								disabled={loading || !results || page >= results.pages}
								onClick={() => results && setPage(results.pages)}
							>
								Last
							</button>
						</div>
					</div>
				</>
			)}
		</div>
	);
}

function CoverageView({
	coverage,
	error,
	onRetry,
}: {
	coverage: Coverage | null;
	error: string;
	onRetry: () => void;
}) {
	if (error)
		return (
			<div className="error-box" role="alert">
				{error}
				<button className="button" onClick={onRetry}>
					Retry coverage
				</button>
			</div>
		);
	if (!coverage) return <div className="library-loading">Checking installed datasets…</div>;
	return (
		<div className="library-coverage">
			<div className="library-coverage-heading">
				<div>
					<h3>
						{coverage.complete
							? 'All source datasets installed'
							: coverage.datasets.length
								? 'Catalog is incomplete'
								: 'No complete catalog installed'}
					</h3>
					<p className="muted">
						Release:{' '}
						{typeof coverage.release === 'object'
							? coverage.release
								? [coverage.release.date, coverage.release.version].filter(Boolean).join(' · ')
								: 'Unknown'
							: coverage.release || 'Unknown'}
						. Counts compare imported records with the source indexes.
					</p>
				</div>
				<button className="button small" onClick={onRetry}>
					<Icon name="refresh" />
					Refresh
				</button>
			</div>
			{coverage.issues.length > 0 && (
				<div className="library-issues" role="status">
					<h3>Missing or incomplete data</h3>
					<ul>
						{coverage.issues.map((issue, i) => (
							<li key={i}>{text(issue)}</li>
						))}
					</ul>
				</div>
			)}
			<div className="library-table-wrap">
				<table className="library-table">
					<thead>
						<tr>
							<th>Dataset</th>
							<th>Imported</th>
							<th>Expected</th>
							<th>Status</th>
							<th>Date</th>
						</tr>
					</thead>
					<tbody>
						{coverage.datasets.map((dataset) => (
							<tr key={dataset.name}>
								<td>
									<strong>{dataset.name}</strong>
									{dataset.sha256 && (
										<details className="library-checksum">
											<summary>SHA-256</summary>
											<code>{dataset.sha256}</code>
										</details>
									)}
								</td>
								<td className="mono">{number(dataset.imported)}</td>
								<td className="mono">{number(dataset.expected)}</td>
								<td>
									<span className={`badge ${dataset.complete ? 'success' : ''}`}>
										{dataset.complete ? 'Complete' : dataset.imported ? 'Partial' : 'Missing'}
									</span>
								</td>
								<td className="mono">{dataset.date || '—'}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{Object.keys(coverage.counts).length > 0 && (
				<dl className="library-counts">
					{Object.entries(coverage.counts).map(([key, value]) => (
						<div key={key}>
							<dt>{label(key)}</dt>
							<dd>{number(value)}</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	);
}
