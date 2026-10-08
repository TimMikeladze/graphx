import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, Search01Icon } from '@hugeicons/core-free-icons';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { type Brief, type NodeKind, type Scope, useSearch } from '~/atlas';
import { NodeRow } from '~/components/node-row';

/** Debounce a value: search runs when typing pauses, not on every key. */
function useDebounced<T>(value: T, ms = 180): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const id = setTimeout(() => setV(value), ms);
		return () => clearTimeout(id);
	}, [value, ms]);
	return v;
}

/**
 * Hybrid search over the graph (`/atlas/search`) with a results dropdown. `types` narrows what can be
 * picked — the path finder takes any node; the header search takes everything.
 */
export function SearchBox({
	onPick,
	scope,
	placeholder = 'Search people, episodes, topics…',
	types,
	value,
	onClear,
	className,
	autoFocus,
}: {
	onPick: (node: Brief) => void;
	scope: Scope;
	placeholder?: string;
	types?: NodeKind[];
	/** A picked node to show in place of the input (the path finder's slots). */
	value?: Brief;
	onClear?: () => void;
	className?: string;
	autoFocus?: boolean;
}) {
	const [q, setQ] = useState('');
	const [open, setOpen] = useState(false);
	const [cursor, setCursor] = useState(0);
	const query = useDebounced(q);
	const search = useSearch(query, scope);
	const results = (search.data?.results ?? []).filter((r) => !types || types.includes(r.type));
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => setCursor(0), [query]);
	useEffect(() => {
		const close = (e: MouseEvent) => {
			if (!box.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('mousedown', close);
		return () => document.removeEventListener('mousedown', close);
	}, []);

	const pick = (n: Brief) => {
		onPick(n);
		setQ('');
		setOpen(false);
	};

	if (value) {
		return (
			<div
				className={cn(
					'flex h-9 items-center gap-1 rounded-md border border-border bg-input/20 pr-1',
					className,
				)}
			>
				<div className="min-w-0 flex-1">
					<NodeRow node={value} compact />
				</div>
				<button
					type="button"
					onClick={onClear}
					aria-label="Clear"
					className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
				</button>
			</div>
		);
	}

	return (
		<div ref={box} className={cn('relative', className)}>
			<HugeiconsIcon
				icon={Search01Icon}
				className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				value={q}
				autoFocus={autoFocus}
				onChange={(e) => {
					setQ(e.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onKeyDown={(e) => {
					if (e.key === 'ArrowDown') {
						e.preventDefault();
						setCursor((c) => Math.min(c + 1, results.length - 1));
					} else if (e.key === 'ArrowUp') {
						e.preventDefault();
						setCursor((c) => Math.max(c - 1, 0));
					} else if (e.key === 'Enter' && results[cursor]) {
						pick(results[cursor]);
					} else if (e.key === 'Escape') {
						setOpen(false);
					}
				}}
				placeholder={placeholder}
				aria-label={placeholder}
				className="h-9 pl-8"
			/>
			{open && q.trim().length > 1 && (
				<div className="absolute top-full right-0 left-0 z-50 mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl">
					{results.length === 0 ? (
						<p className="px-2 py-3 text-xs text-muted-foreground">
							{search.isFetching ? 'Searching…' : 'Nothing matches.'}
						</p>
					) : (
						results.map((r, i) => (
							<NodeRow key={r.id} node={r} active={i === cursor} onClick={() => pick(r)} />
						))
					)}
				</div>
			)}
		</div>
	);
}
