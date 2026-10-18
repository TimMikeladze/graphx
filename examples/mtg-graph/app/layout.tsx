import type { Metadata } from 'next';
import Workspace from '@/components/workspace';
import localFont from 'next/font/local';
import '@xyflow/react/dist/style.css';
import './globals.css';
import './workbench.css';
import './graph.css';
import '../components/library.css';
import '../components/library-record.css';
const sans = localFont({
	src: './fonts/GeistSans.woff2',
	variable: '--font-geist-sans',
	weight: '100 900',
	display: 'swap',
});
const mono = localFont({
	src: './fonts/GeistMono.woff2',
	variable: '--font-geist-mono',
	weight: '100 900',
	display: 'swap',
});
export const metadata: Metadata = {
	title: 'MTG / GraphX',
	description: 'Card explorer, deck construction and graph analysis.',
};
export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`${sans.variable} ${mono.variable}`}>
			<body>
				<Workspace>{children}</Workspace>
			</body>
		</html>
	);
}
