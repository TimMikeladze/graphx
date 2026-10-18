import { notFound } from 'next/navigation';
import { join } from 'node:path';
import LibraryRoute from '@/components/library-route';
import { resolveLibraryRoute, librarySectionLabel } from '@/src/library-navigation';
import { CatalogStore } from '@/src/library';
type Props = { params: Promise<{ segments?: string[] }> };
function resolveRoute(segments: string[] | undefined) {
	const catalog = new CatalogStore(join(process.cwd(), 'catalog.db'));
	try {
		return resolveLibraryRoute(segments, (kind, id) => {
			const summary = catalog.summary(kind, id);
			return summary ? { id: String(summary.id), name: String(summary.name) } : null;
		});
	} finally {
		catalog.close();
	}
}
export async function generateMetadata({ params }: Props) {
	const route = resolveRoute((await params).segments);
	return {
		title: `${route?.name ?? (route ? librarySectionLabel(route.kind) : 'Page not found')} · Library · MTG / GraphX`,
	};
}
export default async function Page({ params }: Props) {
	const route = resolveRoute((await params).segments);
	if (!route) notFound();
	return <LibraryRoute {...route} />;
}
