import Link from 'next/link';

/** `win`/`loss`/`draw`/`nc` outcome pill. */
export function OutcomePill({ outcome }: { outcome: string }) {
	return <span className={`pill ${outcome}`}>{outcome === 'nc' ? 'NC' : outcome}</span>;
}

/** Championship-fight flag; hover for the belt and how it went. */
export function TitlePill({ title }: { title: { name: string; outcome: string } | null }) {
	if (!title) return null;
	return (
		<span className="pill title" title={`${title.name} — ${title.outcome}`}>
			belt
		</span>
	);
}

/** Link to a fighter page when the id exists, else the bare name. */
export function FighterLink({ id, name }: { id?: string | null; name?: string | null }) {
	if (!id) return <>{name ?? ''}</>;
	return <Link href={`/fighter/${id}`}>{name ?? id}</Link>;
}
