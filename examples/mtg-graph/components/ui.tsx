'use client';
import { useEffect, useState, useRef } from 'react';
import type { Card } from '@/src/schema';
import { colorNames } from '@/src/workbench';
export function Icon({
	name,
	size = 16,
	...props
}: { name: string; size?: number } & React.SVGProps<SVGSVGElement>) {
	const paths: Record<string, React.ReactNode> = {
		expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
		collapse: <path d="M3 8h5V3m13 5h-5V3M3 16h5v5m13-5h-5v5" />,
		panel: (
			<>
				<rect x="3" y="3" width="18" height="18" rx="2" />
				<path d="M9 3v18" />
			</>
		),
		database: (
			<>
				<ellipse cx="12" cy="5" rx="8" ry="3" />
				<path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
			</>
		),
		chevrons: <path d="m9 9 3-3 3 3m-6 6 3 3 3-3" />,
		search: (
			<>
				<circle cx="10.5" cy="10.5" r="6.5" />
				<path d="m16 16 4 4" />
			</>
		),
		plus: <path d="M12 5v14M5 12h14" />,
		close: <path d="m6 6 12 12M18 6 6 18" />,
		arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
		chevron: <path d="m9 5 7 7-7 7" />,
		grid: (
			<>
				<rect x="4" y="4" width="6" height="6" rx="1" />
				<rect x="14" y="4" width="6" height="6" rx="1" />
				<rect x="4" y="14" width="6" height="6" rx="1" />
				<rect x="14" y="14" width="6" height="6" rx="1" />
			</>
		),
		list: (
			<>
				<path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01" />
			</>
		),
		check: <path d="m5 12 4 4L19 6" />,
		download: (
			<>
				<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" />
			</>
		),
		copy: (
			<>
				<rect x="8" y="8" width="12" height="13" rx="2" />
				<path d="M16 8V3H3v13h5" />
			</>
		),
		graph: (
			<>
				<circle cx="12" cy="5" r="2.5" />
				<circle cx="5" cy="18" r="2.5" />
				<circle cx="20" cy="17" r="2.5" />
				<path d="m11 7-5 9m8-9 5 8M8 18h9" />
			</>
		),
		code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" />,
		deck: (
			<>
				<rect x="7" y="4" width="13" height="17" rx="2" />
				<path d="M7 17H4V2h12v2" />
			</>
		),
		chart: (
			<>
				<path d="M4 3v18h17M8 16v-5m5 5V6m5 10v-7" />
			</>
		),
		filter: <path d="M4 7h16M7 12h10M10 17h4" />,
		star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />,
		compare: (
			<>
				<path d="M9 3v18M15 3v18M3 7h6m6 10h6" />
				<path d="m6 4 3 3-3 3m12 4-3 3 3 3" />
			</>
		),
		undo: (
			<>
				<path d="m8 3-5 5 5 5M3 8h10a7 7 0 0 1 0 14" />
			</>
		),
		redo: (
			<>
				<path d="m16 3 5 5-5 5m5-5H11a7 7 0 0 0 0 14" />
			</>
		),
		layers: (
			<>
				<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5" />
			</>
		),
		refresh: (
			<>
				<path d="M20 7v5h-5M4 17v-5h5" />
				<path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2" />
			</>
		),
		book: (
			<>
				<path d="M12 6c-3-3-7-3-10-1v15c4-2 7-2 10 0 3-2 6-2 10 0V5c-3-2-7-2-10 1v14" />
			</>
		),
		external: <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" />,
		help: (
			<>
				<circle cx="12" cy="12" r="9" />
				<path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01" />
			</>
		),
	};
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...props}
		>
			{paths[name] ?? paths.arrow}
		</svg>
	);
}
export function Mana({ cost }: { cost: string }) {
	return (
		<span className="mana">
			{(cost.match(/\{[^}]+\}/g) ?? []).map((token, i) => (
				<span key={i} title={token} className="mana-symbol" data-color={token.slice(1, -1)}>
					{token.slice(1, -1)}
				</span>
			))}
		</span>
	);
}
export function Colors({ colors }: { colors: string[] }) {
	return (
		<span className="colors">
			{(colors.length ? colors : ['C']).map((c) => (
				<span
					key={c}
					className="color-symbol"
					data-color={c}
					title={colorNames[c] ?? c}
					aria-label={colorNames[c] ?? c}
				>
					{({ W: '☀', U: '◒', B: '◈', R: '♨', G: '♣', C: '◇' } as Record<string, string>)[c] ?? c}
				</span>
			))}
		</span>
	);
}
export function CardImage({
	card,
	face = 'front',
	className = '',
}: {
	card: Card;
	face?: string;
	className?: string;
}) {
	const [failed, setFailed] = useState(false);
	useEffect(() => setFailed(false), [card.id, face]);
	const id = card.scryfallId;
	const src = id ? `/api/image/${id}?face=${face}` : null;
	return src && !failed ? (
		<img
			className={`card-image ${className}`}
			src={src}
			loading="lazy"
			alt={card.name}
			onError={() => setFailed(true)}
		/>
	) : (
		<div className={`card-image fallback ${className}`}>
			<span>{card.name}</span>
			<Mana cost={card.manaCost} />
			<small>{card.type}</small>
		</div>
	);
}
export async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
	const response = await fetch(`/api/v1${path}`, {
		...options,
		headers: { 'Content-Type': 'application/json', ...options?.headers },
	});
	const json = await response.json();
	if (!response.ok) throw new Error(json.error?.message ?? `HTTP ${response.status}`);
	return json as T;
}
export function Empty({ children }: { children: React.ReactNode }) {
	return <div className="empty">{children}</div>;
}
export function Modal({
	title,
	children,
	onClose,
	wide = false,
}: {
	title: string;
	children: React.ReactNode;
	onClose: () => void;
	wide?: boolean;
}) {
	const panel = useRef<HTMLElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const old = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		const listener = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close.current();
			if (e.key === 'Tab') {
				const focusable = [
					...(panel.current?.querySelectorAll<HTMLElement>(
						'button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]',
					) ?? []),
				].filter((el) => el.offsetParent !== null);
				const first = focusable[0],
					last = focusable.at(-1);
				if (e.shiftKey && document.activeElement === first) {
					e.preventDefault();
					last?.focus();
				} else if (!e.shiftKey && document.activeElement === last) {
					e.preventDefault();
					first?.focus();
				}
			}
		};
		document.addEventListener('keydown', listener);
		return () => {
			document.body.style.overflow = old;
			document.removeEventListener('keydown', listener);
			previous?.focus();
		};
	}, []);
	return (
		<div className="overlay" onClick={onClose}>
			<section
				ref={panel}
				className={`modal ${wide ? 'wide' : ''}`}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				onClick={(e) => e.stopPropagation()}
			>
				<header>
					<h2>{title}</h2>
					<button autoFocus aria-label="Close dialog" className="icon-btn" onClick={onClose}>
						<Icon name="close" />
					</button>
				</header>
				{children}
			</section>
		</div>
	);
}
export function Skeleton() {
	return (
		<div className="skeletons">
			{Array.from({ length: 8 }, (_, i) => (
				<div className="skeleton" key={i} />
			))}
		</div>
	);
}
export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
	const [done, setDone] = useState(false);
	return (
		<button
			className="button small"
			onClick={async () => {
				await navigator.clipboard.writeText(text);
				setDone(true);
				setTimeout(() => setDone(false), 1500);
			}}
		>
			<Icon name={done ? 'check' : 'copy'} />
			{done ? 'Copied' : label}
		</button>
	);
}
const cardCache = new Map<string, Card>();
export function useCardMap(ids: string[]) {
	const [map, setMap] = useState<Map<string, Card>>(new Map());
	const signature = [...new Set(ids)].sort().join('|');
	useEffect(() => {
		let alive = true;
		const keys = signature ? signature.split('|') : [];
		Promise.all(
			keys.map(async (id) => {
				if (!cardCache.has(id))
					cardCache.set(id, await api<Card>(`/cards/${encodeURIComponent(id)}`));
				return [id, cardCache.get(id)!] as const;
			}),
		)
			.then((entries) => {
				if (alive) setMap(new Map(entries));
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [signature]);
	return map;
}
