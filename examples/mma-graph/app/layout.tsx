import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';
import { SearchBox } from '@/components/search-box';
import './globals.css';

export const metadata: Metadata = {
	title: 'MMA graph — every fighter, every fight, across time',
	description:
		'Every fighter with a Wikipedia record — every fight, every promotion, one temporal graph. Next.js + graphx.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>
				<header className="top">
					<a className="brand" href="/">
						mma<b>·</b>graph
					</a>
					<Nav />
					<SearchBox />
				</header>
				<main>{children}</main>
			</body>
		</html>
	);
}
