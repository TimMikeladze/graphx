'use client';
import { useWorkspaceActions } from './workspace';
import Library from './library';
import LibraryRecord from './library-record';
import type { LibrarySection } from '@/src/library-navigation';
export default function LibraryRoute({
	kind,
	id,
	name,
}: {
	kind: LibrarySection;
	id?: string;
	name?: string;
}) {
	const actions = useWorkspaceActions();
	return id && kind !== 'coverage' ? (
		<LibraryRecord key={`${kind}:${id}`} kind={kind} id={id} name={name} {...actions} />
	) : (
		<Library kind={kind} />
	);
}
