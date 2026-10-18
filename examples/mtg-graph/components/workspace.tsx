'use client';
import {
	createContext,
	useContext,
	useCallback,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Card, DeckRecord } from '@/src/schema';
import { api, Icon, Modal } from './ui';
import Explorer from './explorer';
import Decks from './decks';
import Analysis from './analysis';
import GraphView from './graph-view';
import ApiConsole from './api-console';
import CardDetail from './card-detail';
import { AppSidebar, navigation as tabs } from './app-sidebar';
import { SidebarProvider, SidebarInset, SidebarTrigger } from './ui/sidebar';
const WorkspaceActions = createContext<{
	notify: (message: string) => void;
	onCopy: (deck: DeckRecord) => void;
} | null>(null);
export function useWorkspaceActions() {
	const actions = useContext(WorkspaceActions);
	if (!actions) throw new Error('Workspace actions require the shared layout');
	return actions;
}
export default function Workspace({ children }: { children?: ReactNode }) {
	const router = useRouter(),
		pathname = usePathname();
	const libraryActive = pathname === '/library' || pathname.startsWith('/library/');
	const [tab, setTab] = useState('Cards');
	const activeTab = libraryActive ? 'Library' : tab;
	const [status, setStatus] = useState<any>(null);
	const [decks, setDecks] = useState<DeckRecord[]>([]);
	const [deckId, setDeckId] = useState('');
	const [selected, setSelected] = useState<Card | null>(null);
	const [graphCard, setGraphCard] = useState<Card | null>(null);
	const [toast, setToast] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [help, setHelp] = useState(false);
	const saving = useRef(false);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [undoStack, setUndoStack] = useState<Record<string, DeckRecord[]>>({});
	const [redoStack, setRedoStack] = useState<Record<string, DeckRecord[]>>({});
	const deck = decks.find((d) => d.id === deckId) ?? decks[0] ?? null;
	const notify = useCallback((message: string) => {
		setToast(message);
		if (toastTimer.current) clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(''), 3500);
	}, []);
	const refresh = useCallback(async () => {
		try {
			const [s, ds] = await Promise.all([api('/status'), api<DeckRecord[]>('/decks')]);
			setStatus(s);
			setDecks(ds);
			setDeckId((id) => {
				let preferred = id;
				try {
					preferred ||= localStorage.getItem('mtg-active-deck') ?? '';
				} catch {}
				return ds.some((d) => d.id === preferred) ? preferred : (ds[0]?.id ?? '');
			});
			setError('');
		} catch (e) {
			setError((e as Error).message);
		}
	}, []);
	useEffect(() => {
		refresh();
		const update = () => {
			const name = tabs.find(([name]) => name.toLowerCase() === location.hash.slice(1))?.[0];
			if (name === 'Library') router.replace('/library/sets');
			else if (name) setTab(name);
		};
		window.addEventListener('hashchange', update);
		const initial = location.hash.slice(1);
		if (initial === 'library') router.replace('/library/sets');
		else if (tabs.some(([name]) => name.toLowerCase() === initial))
			setTab(tabs.find(([name]) => name.toLowerCase() === initial)![0]);
		return () => window.removeEventListener('hashchange', update);
	}, [refresh, router]);
	useEffect(() => {
		const id = new URLSearchParams(location.search).get('card');
		if (id)
			api<Card>(`/cards/${encodeURIComponent(id)}`)
				.then(setSelected)
				.catch((e) => notify(e.message));
		return () => {
			if (toastTimer.current) clearTimeout(toastTimer.current);
		};
	}, [notify]);
	const chooseDeck = (id: string) => {
		setDeckId(id);
		try {
			localStorage.setItem('mtg-active-deck', id);
		} catch {}
	};
	const selectCard = (card: Card | null) => {
		setSelected(card);
		const url = new URL(location.href);
		if (card) url.searchParams.set('card', card.id);
		else url.searchParams.delete('card');
		history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
	};
	const navigate = (name: string) => {
		if (name === 'Library') {
			router.push('/library/sets');
			return;
		}
		setTab(name);
		if (libraryActive) {
			router.push(`/#${name.toLowerCase()}`);
			return;
		}
		history.replaceState(null, '', `${location.pathname}${location.search}#${name.toLowerCase()}`);
	};
	const persist = async (d: DeckRecord, remember = true) => {
		if (saving.current) throw new Error('A deck save is in progress');
		saving.current = true;
		setBusy(true);
		try {
			const saved = await api<DeckRecord>(`/decks/${d.id}`, {
				method: 'PUT',
				body: JSON.stringify(d),
			});
			if (remember) {
				const previous = decks.find((old) => old.id === d.id);
				if (previous)
					setUndoStack((old) => ({ ...old, [d.id]: [...(old[d.id] ?? []), previous].slice(-30) }));
				setRedoStack((old) => ({ ...old, [d.id]: [] }));
			}
			setDecks((ds) => ds.map((old) => (old.id === saved.id ? saved : old)));
			return saved;
		} catch (e) {
			notify((e as Error).message);
			throw e;
		} finally {
			saving.current = false;
			setBusy(false);
		}
	};
	const save = (d: DeckRecord) => persist(d);
	const travel = async (direction: 'undo' | 'redo') => {
		if (!deck || saving.current) return;
		const stack = direction === 'undo' ? undoStack : redoStack;
		const target = stack[deck.id]?.at(-1);
		if (!target) return;
		try {
			await persist({ ...target, revision: deck.revision }, false);
			const remove = direction === 'undo' ? setUndoStack : setRedoStack;
			const append = direction === 'undo' ? setRedoStack : setUndoStack;
			remove((old) => ({ ...old, [deck.id]: (old[deck.id] ?? []).slice(0, -1) }));
			append((old) => ({ ...old, [deck.id]: [...(old[deck.id] ?? []), deck].slice(-30) }));
			notify(direction === 'undo' ? 'Edit undone' : 'Edit restored');
		} catch {}
	};
	const add = async (card: Card, board: 'main' | 'side' | 'maybe' = 'main') => {
		if (!deck) {
			notify('Create a deck first');
			navigate('Decks');
			return;
		}
		const entries = deck.entries.map((e) => ({ ...e }));
		const existing = entries.find((e) => e.cardId === card.id && e.board === board);
		if (existing) existing.quantity++;
		else entries.push({ cardId: card.id, quantity: 1, board });
		try {
			await save({ ...deck, entries });
			notify(`Added ${card.name}`);
		} catch {}
	};
	const showGraph = (card: Card) => {
		setGraphCard(card);
		selectCard(null);
		navigate('Graph');
	};
	return (
		<WorkspaceActions.Provider
			value={{
				notify,
				onCopy: (copied) => {
					setDecks((old) => [...old.filter((d) => d.id !== copied.id), copied]);
					chooseDeck(copied.id);
					navigate('Decks');
				},
			}}
		>
			<SidebarProvider>
				<a className="skip-link" href="#workspace-content">
					Skip to content
				</a>
				<AppSidebar
					tab={activeTab}
					onNavigate={navigate}
					deckCount={decks.length}
					status={status}
				/>
				<SidebarInset>
					<header className="workspace-header">
						<div className="workspace-breadcrumb">
							<SidebarTrigger />
							<span className="header-divider" />
							<span className="breadcrumb-parent">Workspace</span>
							<Icon name="chevron" size={12} />
							<span>
								{activeTab === 'Cards'
									? 'Card explorer'
									: activeTab === 'API'
										? 'API console'
										: activeTab === 'Graph'
											? 'Graph explorer'
											: activeTab}
							</span>
						</div>
						<div className="header-actions">
							<span className="badge success">
								<span className="status-dot ready" />
								Local workspace
							</span>
							<span className="header-release">
								MTGJSON <span className="mono">{status?.dataset?.date ?? '…'}</span>
							</span>
							<button
								className="icon-btn"
								aria-label="Help"
								title="Query syntax"
								onClick={() => setHelp(true)}
							>
								<Icon name="help" />
							</button>
						</div>
					</header>
					{error ? (
						<main className="page" id="workspace-content" tabIndex={-1}>
							<div className="error-box">
								{error}
								<button className="button small" onClick={refresh}>
									Retry
								</button>
							</div>
						</main>
					) : (
						<main className="page" id="workspace-content" tabIndex={-1}>
							{pathname !== '/' ? (
								children
							) : (
								<>
									{tab === 'Cards' && (
										<Explorer
											deck={deck}
											decks={decks}
											onChoose={chooseDeck}
											status={status}
											onSelect={selectCard}
											onAdd={add}
											onDeck={() => navigate('Decks')}
											busy={busy}
										/>
									)}
									{tab === 'Decks' && (
										<Decks
											decks={decks}
											deck={deck}
											onChoose={chooseDeck}
											onRefresh={refresh}
											onSave={save}
											onSelect={selectCard}
											onAnalyze={() => navigate('Analysis')}
											notify={notify}
											busy={busy}
											onUndo={() => travel('undo')}
											onRedo={() => travel('redo')}
											canUndo={Boolean(deck && undoStack[deck.id]?.length)}
											canRedo={Boolean(deck && redoStack[deck.id]?.length)}
										/>
									)}

									{tab === 'Analysis' && (
										<Analysis
											deck={deck}
											onSelect={selectCard}
											onAdd={add}
											onDeck={() => navigate('Decks')}
										/>
									)}
									{tab === 'Graph' && (
										<GraphView card={graphCard} onCard={setGraphCard} onSelect={selectCard} />
									)}
									{tab === 'API' && <ApiConsole status={status} deck={deck} />}
								</>
							)}
						</main>
					)}
					<footer className="footer">
						<span>
							<span className={`status-dot ${status ? 'ready' : ''}`} />
							{status
								? `${Number(status.dataset?.cards).toLocaleString()} cards · ${Number(status.edges).toLocaleString()} edges`
								: 'Loading catalog'}
						</span>
						<span>
							<a href="https://mtgjson.com/" target="_blank" rel="noreferrer">
								MTGJSON
							</a>{' '}
							{status?.dataset?.date ?? ''}
							{status?.dataset?.coverage === 'snapshot' && ' · Snapshot'}
							<span className="footer-separator">/</span>GraphX
						</span>
					</footer>
					<nav className="mobile-tabs" aria-label="Primary navigation">
						{tabs.map(([name, icon]) => (
							<Link
								key={name}
								href={name === 'Library' ? '/library/sets' : `/#${name.toLowerCase()}`}
								aria-current={activeTab === name ? 'page' : undefined}
								onNavigate={(event) => {
									event.preventDefault();
									navigate(name);
								}}
							>
								<Icon name={icon} size={19} />
								{name}
							</Link>
						))}
					</nav>
				</SidebarInset>
				{selected && (
					<CardDetail
						card={selected}
						onClose={() => selectCard(null)}
						onSelect={selectCard}
						onAdd={add}
						onGraph={showGraph}
						busy={busy}
					/>
				)}
				{toast && (
					<div className="toast" role="status">
						<Icon name="check" />
						{toast}
					</div>
				)}
				{help && (
					<Modal title="Query syntax" onClose={() => setHelp(false)}>
						<div className="modal-body">
							<div className="syntax-table">
								{[
									['t:creature', 'Type'],
									['o:"draw a card"', 'Oracle text'],
									['c:u -c:r', 'Colors, negation'],
									['id=ub', 'Exact color identity'],
									['mv<=2 f:modern', 'Mana value, legality'],
									['k:flying s:mh3', 'Keyword, printing set'],
								].map(([a, b]) => (
									<div key={a}>
										<code>{a}</code>
										<span>{b}</span>
									</div>
								))}
							</div>
							<p className="muted">/ or ⌘K to search · Esc to close</p>
						</div>
					</Modal>
				)}
			</SidebarProvider>
		</WorkspaceActions.Provider>
	);
}
