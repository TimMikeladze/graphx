'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { SearchResult } from '@/src/server/queries';

/** Full-text fighter search (debounced) with `/` to focus, Esc / outside-click to close. */
export function SearchBox() {
	const [value, setValue] = useState('');
	const [results, setResults] = useState<SearchResult[] | null>(null);
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const wrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const t = setTimeout(async () => {
			const q = value.trim();
			if (q.length < 2) {
				setResults(null);
				setOpen(false);
				return;
			}
			try {
				const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
				const body = (await res.json()) as { results: SearchResult[] };
				setResults(body.results);
				setOpen(true);
			} catch {
				/* network hiccup — keep the previous dropdown */
			}
		}, 180);
		return () => clearTimeout(t);
	}, [value]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === '/' && document.activeElement !== inputRef.current) {
				e.preventDefault();
				inputRef.current?.focus();
			}
			if (e.key === 'Escape') setOpen(false);
		};
		const onClick = (e: MouseEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('click', onClick);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('click', onClick);
		};
	}, []);

	return (
		<div className="searchwrap" ref={wrapRef}>
			<span className="icon">⌕</span>
			<input
				ref={inputRef}
				type="search"
				placeholder="Search fighters…  ( / )"
				autoComplete="off"
				spellCheck={false}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onFocus={() => results && results.length > 0 && setOpen(true)}
			/>
			{open && results && (
				<div className="searchdrop">
					{results.length > 0 ? (
						results.map((r) => (
							<Link key={r.id} href={`/fighter/${r.id}`} onClick={() => setOpen(false)}>
								<span>
									{r.name}
									{r.division ? <span className="dim"> · {r.division}</span> : null}
								</span>
								<span className="rec">{r.record ?? ''}</span>
							</Link>
						))
					) : (
						<div className="skeleton" style={{ padding: 14 }}>
							no fighters matched
						</div>
					)}
				</div>
			)}
		</div>
	);
}
