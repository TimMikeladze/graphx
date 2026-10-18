'use client';
import Link from 'next/link';
import { Icon } from './ui';
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
} from './ui/sidebar';
export const navigation = [
	['Cards', 'search'],
	['Library', 'book'],
	['Decks', 'deck'],
	['Analysis', 'chart'],
	['Graph', 'graph'],
	['API', 'code'],
] as const;
export function AppSidebar({
	tab,
	onNavigate,
	deckCount,
	status,
}: {
	tab: string;
	onNavigate: (tab: string) => void;
	deckCount: number;
	status: any;
}) {
	return (
		<Sidebar>
			<SidebarHeader>
				<Link
					className="sidebar-brand"
					href="/#cards"
					onNavigate={(event) => {
						event.preventDefault();
						onNavigate('Cards');
					}}
					title="MTG / GraphX"
				>
					<span className="brand-mark">M</span>
					<span className="sidebar-brand-text">
						<strong>
							mtg <span>/ graphx</span>
						</strong>
						<small>Local workspace</small>
					</span>
					<Icon name="chevrons" size={13} />
				</Link>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup label="Workspace">
					<SidebarMenu>
						{navigation.map(([name, icon]) => (
							<SidebarMenuButton
								key={name}
								label={name}
								href={name === 'Library' ? '/library/sets' : `/#${name.toLowerCase()}`}
								active={tab === name}
								onClick={() => onNavigate(name)}
							>
								<Icon name={icon} size={16} />
								<span className="sidebar-label">
									{name === 'Cards'
										? 'Card explorer'
										: name === 'API'
											? 'API console'
											: name === 'Graph'
												? 'Graph explorer'
												: name}
								</span>
								{name === 'Decks' && deckCount > 0 && (
									<span className="sidebar-badge">{deckCount}</span>
								)}
							</SidebarMenuButton>
						))}
					</SidebarMenu>
				</SidebarGroup>
				<SidebarGroup label="Resources">
					<SidebarMenu>
						<li>
							<a
								data-sidebar="menu-button"
								href="/api/openapi.json"
								target="_blank"
								rel="noreferrer"
								title="OpenAPI schema"
							>
								<Icon name="book" />
								<span className="sidebar-label">OpenAPI schema</span>
								<Icon className="sidebar-external" name="external" size={12} />
							</a>
						</li>
						<li>
							<a
								data-sidebar="menu-button"
								href="https://mtgjson.com/faq/"
								target="_blank"
								rel="noreferrer"
								title="MTGJSON"
							>
								<Icon name="database" />
								<span className="sidebar-label">MTGJSON</span>
								<Icon className="sidebar-external" name="external" size={12} />
							</a>
						</li>
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<div
					className="sidebar-dataset"
					title={status ? `${Number(status.edges).toLocaleString()} graph edges` : 'Connecting'}
				>
					<span className="sidebar-dataset-icon">
						<Icon name="database" size={15} />
					</span>
					<div className="sidebar-label">
						<strong>
							MTGJSON
							<span className={`status-dot ${status ? 'ready' : ''}`} />
						</strong>
						<small>
							{status
								? `${Number(status.dataset.cards).toLocaleString()} cards · ${status.dataset.date}`
								: 'Connecting…'}
						</small>
					</div>
				</div>
				<div className="sidebar-engine">
					<span className={`status-dot ${status ? 'ready' : ''}`} />
					<span className="sidebar-label">
						{status ? 'GraphX connected' : 'Connecting to graph'}
					</span>
					<kbd>⌘B</kbd>
				</div>
			</SidebarFooter>
		</Sidebar>
	);
}
