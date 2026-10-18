'use client';
import Link from 'next/link';
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import { Icon } from '../ui';
interface SidebarContextValue {
	open: boolean;
	openMobile: boolean;
	isMobile: boolean;
	setOpenMobile: (open: boolean) => void;
	toggleSidebar: () => void;
}
const SidebarContext = createContext<SidebarContextValue | null>(null);
export function useSidebar() {
	const context = useContext(SidebarContext);
	if (!context) throw new Error('Sidebar requires SidebarProvider');
	return context;
}
export function SidebarProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(true);
	const [openMobile, setOpenMobile] = useState(false);
	const [isMobile, setIsMobile] = useState(false);
	useEffect(() => {
		const media = matchMedia('(max-width: 767px)');
		const update = () => {
			setIsMobile(media.matches);
			setOpenMobile(false);
		};
		update();
		media.addEventListener('change', update);
		try {
			setOpen(localStorage.getItem('mtg-sidebar') !== 'collapsed');
		} catch {}
		return () => media.removeEventListener('change', update);
	}, []);
	const toggleSidebar = useCallback(() => {
		if (isMobile) setOpenMobile((v) => !v);
		else
			setOpen((v) => {
				try {
					localStorage.setItem('mtg-sidebar', v ? 'collapsed' : 'expanded');
				} catch {}
				return !v;
			});
	}, [isMobile]);
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			if (event.key === 'b' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				toggleSidebar();
			}
		};
		window.addEventListener('keydown', listener);
		return () => window.removeEventListener('keydown', listener);
	}, [toggleSidebar]);
	return (
		<SidebarContext.Provider value={{ open, openMobile, isMobile, setOpenMobile, toggleSidebar }}>
			<div className="sidebar-provider" data-state={open ? 'expanded' : 'collapsed'}>
				{children}
			</div>
		</SidebarContext.Provider>
	);
}
export function Sidebar({ children }: { children: ReactNode }) {
	const { open, isMobile, openMobile, setOpenMobile } = useSidebar();
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		if (isMobile && openMobile && !element.open) element.showModal();
		else if (element.open) element.close();
	}, [isMobile, openMobile]);
	return isMobile ? (
		<dialog
			ref={dialog}
			className="sidebar-sheet"
			aria-label="Workspace navigation"
			onCancel={() => setOpenMobile(false)}
			onClick={(e) => {
				if (e.target === e.currentTarget) setOpenMobile(false);
			}}
		>
			<div className="sidebar-sheet-content" data-sidebar="sidebar">
				<button
					className="sidebar-sheet-close icon-btn"
					onClick={() => setOpenMobile(false)}
					aria-label="Close navigation"
				>
					<Icon name="close" />
				</button>
				{children}
			</div>
		</dialog>
	) : (
		<aside
			className="sidebar"
			data-sidebar="sidebar"
			data-state={open ? 'expanded' : 'collapsed'}
			aria-label="Workspace navigation"
		>
			{children}
		</aside>
	);
}
export function SidebarHeader({ children }: { children: ReactNode }) {
	return (
		<div data-sidebar="header" className="sidebar-header">
			{children}
		</div>
	);
}
export function SidebarContent({ children }: { children: ReactNode }) {
	return (
		<div data-sidebar="content" className="sidebar-content">
			{children}
		</div>
	);
}
export function SidebarFooter({ children }: { children: ReactNode }) {
	return (
		<div data-sidebar="footer" className="sidebar-footer">
			{children}
		</div>
	);
}
export function SidebarGroup({ children, label }: { children: ReactNode; label: string }) {
	return (
		<div data-sidebar="group" className="sidebar-group">
			<div data-sidebar="group-label" className="sidebar-group-label">
				{label}
			</div>
			{children}
		</div>
	);
}
export function SidebarMenu({ children }: { children: ReactNode }) {
	return (
		<ul data-sidebar="menu" className="sidebar-menu">
			{children}
		</ul>
	);
}
export function SidebarMenuButton({
	children,
	active,
	onClick,
	label,
	href,
}: {
	children: ReactNode;
	active?: boolean;
	onClick: () => void;
	label: string;
	href?: string;
}) {
	const { setOpenMobile } = useSidebar();
	return (
		<li data-sidebar="menu-item">
			{href ? (
				<Link
					href={href}
					data-sidebar="menu-button"
					data-active={Boolean(active)}
					aria-current={active ? 'page' : undefined}
					title={label}
					onNavigate={(event) => {
						event.preventDefault();
						onClick();
						setOpenMobile(false);
					}}
				>
					{children}
				</Link>
			) : (
				<button
					data-sidebar="menu-button"
					data-active={Boolean(active)}
					aria-current={active ? 'page' : undefined}
					title={label}
					onClick={() => {
						onClick();
						setOpenMobile(false);
					}}
				>
					{children}
				</button>
			)}
		</li>
	);
}
export function SidebarInset({ children }: { children: ReactNode }) {
	return (
		<div className="sidebar-inset" data-sidebar="inset">
			{children}
		</div>
	);
}
export function SidebarTrigger() {
	const { toggleSidebar, open, isMobile, openMobile } = useSidebar();
	return (
		<button
			className="icon-btn sidebar-trigger"
			aria-label="Toggle sidebar"
			aria-expanded={isMobile ? openMobile : open}
			onClick={toggleSidebar}
			title="Toggle sidebar (⌘B)"
		>
			<Icon name="panel" size={17} />
		</button>
	);
}
