'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
	['/', 'Dashboard', '/'],
	['/fighters', 'Fighters', '/fighters'],
	['/champions', 'Champions', '/champions'],
	['/leaders', 'Leaderboards', '/leaders'],
	['/h2h', 'Head-to-head', '/h2h'],
] as const;

export function Nav() {
	const pathname = usePathname();
	return (
		<nav>
			{LINKS.map(([href, label, view]) => (
				<Link key={href} href={href} className={pathname === view ? 'on' : undefined}>
					{label}
				</Link>
			))}
		</nav>
	);
}
