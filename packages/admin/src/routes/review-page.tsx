import { getRouteApi, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
	ArrowLeft01Icon,
	CheckListIcon,
	GitMergeIcon,
	InboxIcon,
	Unlink01Icon,
} from '@hugeicons/core-free-icons';
import { toast } from 'sonner';
import { Combobox } from '@/components/combobox';
import { EmptyState } from '@/components/empty-state';
import { ThemeToggle } from '@/components/theme-toggle';
import { NodeTypeBadge } from '@/components/type-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useEdges, useNode, useSchema, useSettleReview } from '@/hooks/use-graph';
import { bestLabel } from '@/lib/format';
import { judgmentOf, outcomeOf, promoteRels, reviewRels } from '@/lib/review';
import type { EdgeRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

const reviewRoute = getRouteApi('/t/$tenant/p/$project/review');

/** One side of a pair: the node's type, label, and fields — what a curator compares. */
function NodePanel({ tenant, project, id }: { tenant: string; project: string; id: string }) {
	const node = useNode(tenant, project, id);
	if (node.isLoading) return <Skeleton className="h-28 w-full" />;
	if (!node.data) return <p className="text-xs text-muted-foreground">Node {id} is gone.</p>;
	const fields = Object.entries(node.data.data).filter(([, v]) => v !== undefined && v !== '');
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex items-center gap-2">
				<NodeTypeBadge type={node.data.type} />
				<Link
					to="/t/$tenant/p/$project"
					params={{ tenant, project }}
					search={{ node: id, expand: [] }}
					className="truncate text-sm font-medium hover:underline"
				>
					{bestLabel(node.data.data) ?? id}
				</Link>
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
				{fields.map(([k, v]) => (
					<div key={k} className="contents">
						<dt className="text-muted-foreground">{k}</dt>
						<dd className="line-clamp-3 break-words">
							{typeof v === 'string' ? v : JSON.stringify(v)}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

const OUTCOME_LABEL = {
	different: 'leans different',
	review: 'undecided',
	same: 'leans same',
} as const;

/** Where Jev's score sits between "different" and "same", and which fields disagree. */
function JudgmentPanel({ edge }: { edge: EdgeRecord }) {
	const j = judgmentOf(edge.data);
	return (
		<div className="flex flex-col gap-3">
			{j.score !== null && (
				<div className="flex flex-col gap-1.5">
					<div className="relative h-2 rounded-full bg-muted" aria-hidden>
						{/* The two cut points: below 0.5 is "different", from 1.5 is "same". */}
						<span className="absolute inset-y-0 left-1/4 w-px bg-border" />
						<span className="absolute inset-y-0 left-3/4 w-px bg-border" />
						<span
							className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow"
							style={{ left: `${(j.score / 2) * 100}%` }}
						/>
					</div>
					<div className="flex justify-between text-[0.65rem] text-muted-foreground">
						<span>different</span>
						<span>related</span>
						<span>same</span>
					</div>
					<p className="text-xs">
						Score <span className="font-medium tabular-nums">{j.score.toFixed(2)}</span> of 2 ·{' '}
						{OUTCOME_LABEL[outcomeOf(j.score)]}
						{j.confidence !== null && (
							<span className="text-muted-foreground"> · confidence {j.confidence.toFixed(2)}</span>
						)}
					</p>
				</div>
			)}
			{j.fields.length > 0 && (
				<div className="flex flex-col gap-1" aria-label="Agreement by field">
					{j.fields.map((f) => (
						<div
							key={f.field}
							className="grid grid-cols-[5.5rem_1fr_2.5rem] items-center gap-2 text-xs"
						>
							<span className="truncate text-muted-foreground">{f.field}</span>
							<span className="h-1.5 overflow-hidden rounded-full bg-muted">
								<span
									className={cn(
										'block h-full rounded-full',
										f.agreement < 0.5 ? 'bg-destructive' : 'bg-primary',
									)}
									style={{ width: `${f.agreement * 100}%` }}
								/>
							</span>
							<span className="text-right tabular-nums">{f.agreement.toFixed(2)}</span>
						</div>
					))}
				</div>
			)}
			{j.model && <p className="text-[0.65rem] text-muted-foreground">judged by {j.model}</p>}
		</div>
	);
}

/**
 * The curator's queue. `graphx/jev` writes each pair it cannot settle as a review edge carrying
 * its judgment; here a person sees both nodes side by side, where Jev's score fell, and which
 * fields disagree — then accepts the pair into the chosen rel or rejects it.
 */
export function ReviewPage() {
	const { tenant, project } = reviewRoute.useParams();
	const search = reviewRoute.useSearch();
	const navigate = reviewRoute.useNavigate();
	const schema = useSchema(tenant, project);
	const rels = reviewRels(schema.data);
	const rel = search.rel ?? rels[0];
	const promotes = rel ? promoteRels(schema.data, rel) : [];
	const into = search.into && promotes.includes(search.into) ? search.into : promotes[0];
	const edges = useEdges(tenant, project, rel);
	const settle = useSettleReview(tenant, project);
	const [busy, setBusy] = useState<string | null>(null);
	const rows = edges.data?.pages.flatMap((p) => p.edges) ?? [];

	const decide = async (edge: EdgeRecord, accept: boolean) => {
		setBusy(edge.id);
		try {
			await settle.mutateAsync({ edge, accept, promote: into });
			toast.success(accept ? `Linked as ${into}` : 'Rejected');
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="mx-auto flex min-h-svh max-w-5xl flex-col gap-5 p-4 sm:p-8">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-3">
					<span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
						<HugeiconsIcon icon={CheckListIcon} strokeWidth={2} className="size-4.5" />
					</span>
					<div>
						<h1 className="text-lg font-semibold">Review</h1>
						<p className="text-xs text-muted-foreground">
							Pairs Jev could not settle, for a person to decide
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<ThemeToggle />
					<Button asChild variant="outline" size="sm">
						<Link to="/t/$tenant/p/$project" params={{ tenant, project }} search={{ expand: [] }}>
							<HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
							Explorer
						</Link>
					</Button>
				</div>
			</header>

			<div className="flex flex-wrap items-end gap-3">
				<label className="flex w-56 flex-col gap-1 text-[0.7rem] font-medium text-muted-foreground">
					Queue
					<Combobox
						items={rels.map((r) => ({ value: r, label: r }))}
						value={rel}
						onChange={(r) => navigate({ search: { rel: r } })}
						placeholder="Rel"
					/>
				</label>
				<label className="flex w-56 flex-col gap-1 text-[0.7rem] font-medium text-muted-foreground">
					Accept into
					<Combobox
						items={promotes.map((r) => ({ value: r, label: r }))}
						value={into}
						onChange={(r) => navigate({ search: (prev) => ({ ...prev, into: r }) })}
						placeholder="No rel fits"
						disabled={promotes.length === 0}
					/>
				</label>
				{edges.data && (
					<Badge variant="secondary" className="mb-1">
						{rows.length}
						{edges.hasNextPage ? '+' : ''} to review
					</Badge>
				)}
			</div>

			{edges.isLoading || schema.isLoading ? (
				<div className="flex flex-col gap-3">
					{Array.from({ length: 3 }).map((_, i) => (
						<Skeleton key={i} className="h-40 w-full" />
					))}
				</div>
			) : edges.isError ? (
				<EmptyState
					icon={InboxIcon}
					tone="destructive"
					title="Could not load the queue"
					hint={edges.error.message}
				/>
			) : rows.length === 0 ? (
				<EmptyState
					icon={InboxIcon}
					title="Nothing to review"
					hint={
						<>
							Pairs appear here when <code>resolveEntities</code> or <code>judgePairs</code> writes
							to <code>{rel ?? 'a review rel'}</code>.
						</>
					}
				/>
			) : (
				<ul className="flex flex-col gap-3">
					{rows.map((edge) => (
						<li key={edge.id}>
							<Card className="grid gap-4 px-4 md:grid-cols-[1fr_16rem_1fr]">
								<NodePanel tenant={tenant} project={project} id={edge.src} />
								<div className="flex flex-col justify-between gap-3 border-y py-3 md:border-x md:border-y-0 md:px-4 md:py-0">
									<JudgmentPanel edge={edge} />
									<div className="flex gap-2">
										<Button
											size="sm"
											className="flex-1"
											disabled={!into || busy !== null}
											onClick={() => decide(edge, true)}
										>
											<HugeiconsIcon icon={GitMergeIcon} strokeWidth={2} />
											Same
										</Button>
										<Button
											size="sm"
											variant="outline"
											className="flex-1"
											disabled={busy !== null}
											onClick={() => decide(edge, false)}
										>
											<HugeiconsIcon icon={Unlink01Icon} strokeWidth={2} />
											Different
										</Button>
									</div>
								</div>
								<NodePanel tenant={tenant} project={project} id={edge.dst} />
							</Card>
						</li>
					))}
				</ul>
			)}
			{edges.hasNextPage && (
				<Button
					variant="outline"
					className="self-center"
					disabled={edges.isFetchingNextPage}
					onClick={() => edges.fetchNextPage()}
				>
					Load more
				</Button>
			)}
		</div>
	);
}
