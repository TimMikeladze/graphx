import { HugeiconsIcon } from '@hugeicons/react';
import {
	Cancel01Icon,
	LinkSquare02Icon,
	Target02Icon,
	TextIcon,
	YoutubeIcon,
} from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { colorForType } from '@/lib/graph-style';
import {
	atTime,
	type Brief,
	type Detail,
	type EpisodeDetail,
	fmtClock,
	fmtDate,
	type GroupDetail,
	type PersonDetail,
	type PodcastDetail,
	type Scope,
	useDetail,
} from '~/atlas';
import { Chip, NodeRow, Section } from '~/components/node-row';

/**
 * The right-hand panel: one node and everything around it. Every node it lists is a link that
 * selects it; "Focus" re-centers the canvas on it.
 */
export function DetailPanel({
	id,
	scope,
	focused,
	onSelect,
	onFocus,
	onClose,
}: {
	id: string;
	scope: Scope;
	focused: boolean;
	onSelect: (n: Brief) => void;
	onFocus: (id: string) => void;
	onClose: () => void;
}) {
	const detail = useDetail(id, scope);
	const d = detail.data;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-start gap-2 border-b border-border p-3">
				<div className="min-w-0 flex-1">
					{d ? (
						<>
							<div className="flex items-center gap-1.5 text-[0.6875rem] tracking-wider text-muted-foreground uppercase">
								<span
									className="inline-block size-2 rounded-full"
									style={{ backgroundColor: colorForType(d.type) }}
								/>
								{d.type}
								{d.type === 'episode' && d.podcastNode && <span>· {d.podcastNode.label}</span>}
								{d.type === 'episode' && d.publishedAt && <span>· {fmtDate(d.publishedAt)}</span>}
							</div>
							<h2 className="mt-1 text-base leading-snug font-semibold text-foreground">
								{d.type === 'episode' ? d.data.title : d.label}
							</h2>
						</>
					) : detail.isError ? (
						<p className="text-sm text-muted-foreground">Not in the graph at this date.</p>
					) : (
						<Skeleton className="h-10 w-full" />
					)}
				</div>
				<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close details">
					<HugeiconsIcon icon={Cancel01Icon} />
				</Button>
			</div>
			{d && (
				<div className="flex flex-wrap gap-2 border-b border-border px-3 py-2">
					<Button
						variant={focused ? 'secondary' : 'outline'}
						size="sm"
						disabled={focused}
						onClick={() => onFocus(d.id)}
					>
						<HugeiconsIcon icon={Target02Icon} data-icon="inline-start" />
						{focused ? 'Graph centered here' : 'Center graph here'}
					</Button>
					{d.type === 'episode' && d.data.youtubeUrl && (
						<Button variant="outline" size="sm" asChild>
							<a href={d.data.youtubeUrl} target="_blank" rel="noreferrer">
								<HugeiconsIcon icon={YoutubeIcon} data-icon="inline-start" />
								Watch
							</a>
						</Button>
					)}
					{d.type === 'episode' && d.data.transcriptUrl && (
						<Button variant="outline" size="sm" asChild>
							<a href={d.data.transcriptUrl} target="_blank" rel="noreferrer">
								<HugeiconsIcon icon={TextIcon} data-icon="inline-start" />
								Transcript
							</a>
						</Button>
					)}
					{d.type === 'episode' && d.data.url !== d.data.transcriptUrl && (
						<Button variant="outline" size="sm" asChild>
							<a href={d.data.url} target="_blank" rel="noreferrer">
								<HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-start" />
								Episode page
							</a>
						</Button>
					)}
					{d.type === 'podcast' && (
						<Button variant="outline" size="sm" asChild>
							<a href={d.data.url} target="_blank" rel="noreferrer">
								<HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-start" />
								Website
							</a>
						</Button>
					)}
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-6">
				{d && <Body d={d} onSelect={onSelect} />}
			</div>
		</div>
	);
}

function Body({ d, onSelect }: { d: Detail; onSelect: (n: Brief) => void }) {
	if (d.type === 'episode') return <Episode d={d} onSelect={onSelect} />;
	if (d.type === 'person') return <Person d={d} onSelect={onSelect} />;
	if (d.type === 'podcast') return <Podcast d={d} onSelect={onSelect} />;
	return <Group d={d} onSelect={onSelect} />;
}

function Episode({ d, onSelect }: { d: EpisodeDetail; onSelect: (n: Brief) => void }) {
	return (
		<>
			{d.image && (
				<a
					href={d.data.youtubeUrl ?? d.data.url}
					target="_blank"
					rel="noreferrer"
					className="mx-2 mt-3 block"
				>
					<img
						src={d.image}
						alt=""
						className="aspect-video w-full rounded-lg object-cover ring-1 ring-border"
					/>
				</a>
			)}
			{d.data.summary && (
				<p className="px-2 pt-3 text-sm leading-relaxed text-muted-foreground">{d.data.summary}</p>
			)}
			{d.podcastNode && (
				<Section title="Show">
					<NodeRow node={d.podcastNode} onClick={() => onSelect(d.podcastNode as Brief)} />
				</Section>
			)}
			{d.guests.length > 0 && (
				<Section title={d.guests.length === 1 ? 'Guest' : `Guests · ${d.guests.length}`}>
					{d.guests.map((g) => (
						<NodeRow key={g.id} node={g} onClick={() => onSelect(g)} />
					))}
				</Section>
			)}
			{d.topics.length > 0 && (
				<Section title="Topics">
					<div className="flex flex-wrap gap-1.5 px-2 pt-1">
						{d.topics.map((t) => (
							<Chip key={t.id} node={t} onClick={() => onSelect(t)} />
						))}
					</div>
				</Section>
			)}
			{d.mentions.length > 0 && (
				<Section title="Brings up">
					{d.mentions.map((m) => (
						<NodeRow
							key={m.id}
							node={m}
							onClick={() => onSelect(m)}
							subtitle={`“${m.chapter}”`}
							trailing={fmtClock(m.startSec)}
						/>
					))}
				</Section>
			)}
			{d.data.chapters.length > 0 && (
				<Section title={`Chapters · ${d.data.chapters.length}`}>
					<ol className="px-2">
						{d.data.chapters.map((c) => (
							<li key={`${c.startSec}-${c.title}`}>
								<a
									href={atTime(d.data.youtubeUrl, c.startSec)}
									target="_blank"
									rel="noreferrer"
									className="flex gap-3 rounded px-1 py-1 text-sm hover:bg-accent/60"
								>
									<span className="w-14 shrink-0 text-right font-mono text-xs leading-5 text-muted-foreground tabular-nums">
										{fmtClock(c.startSec)}
									</span>
									<span className="text-foreground">{c.title}</span>
								</a>
							</li>
						))}
					</ol>
				</Section>
			)}
			{d.sponsors.length > 0 && (
				<Section title="Sponsors">
					<div className="flex flex-wrap gap-1.5 px-2 pt-1">
						{d.sponsors.map((s) => (
							<Chip key={s.id} node={s} onClick={() => onSelect(s)} />
						))}
					</div>
				</Section>
			)}
		</>
	);
}

function Person({ d, onSelect }: { d: PersonDetail; onSelect: (n: Brief) => void }) {
	return (
		<>
			{d.image && (
				<img
					src={d.image}
					alt=""
					className="mx-2 mt-3 aspect-video w-[calc(100%-1rem)] rounded-lg object-cover ring-1 ring-border"
				/>
			)}
			{d.data.tagline && (
				<p className="px-2 pt-3 text-sm text-muted-foreground">{d.data.tagline}</p>
			)}
			{d.hosts.length > 0 && (
				<Section title="Hosts">
					{d.hosts.map((p) => (
						<NodeRow key={p.id} node={p} onClick={() => onSelect(p)} />
					))}
				</Section>
			)}
			{d.episodes.length > 0 && (
				<Section
					title={`${d.shows.length > 1 ? `On ${d.shows.join(' and ')}` : 'Appearances'} · ${d.episodes.length}`}
				>
					{d.episodes.map((e) => (
						<NodeRow key={e.id} node={e} onClick={() => onSelect(e)} />
					))}
				</Section>
			)}
			{d.mentionedIn.length > 0 && (
				<Section title={`Brought up in · ${d.mentionedIn.length}`}>
					{d.mentionedIn.map((m) => (
						<NodeRow
							key={m.id}
							node={m}
							onClick={() => onSelect(m)}
							subtitle={`${fmtDate(m.publishedAt)} · “${m.chapter}”`}
							trailing={fmtClock(m.startSec)}
						/>
					))}
				</Section>
			)}
		</>
	);
}

function Podcast({ d, onSelect }: { d: PodcastDetail; onSelect: (n: Brief) => void }) {
	return (
		<>
			{d.image && (
				<img
					src={d.image}
					alt=""
					className="mx-2 mt-3 aspect-square w-32 rounded-lg object-cover ring-1 ring-border"
				/>
			)}
			<p className="px-2 pt-3 text-sm text-muted-foreground">
				{d.count} episode{d.count === 1 ? '' : 's'}
				{d.first && ` · ${fmtDate(d.first)}`}
				{d.last && d.last !== d.first && ` → ${fmtDate(d.last)}`}
			</p>
			<Section title="Host">
				{d.hostedBy.map((p) => (
					<NodeRow key={p.id} node={p} onClick={() => onSelect(p)} />
				))}
			</Section>
			{d.regulars.length > 0 && (
				<Section title="Came back most">
					{d.regulars.slice(0, 8).map((p) => (
						<NodeRow key={p.id} node={p} onClick={() => onSelect(p)} trailing={`×${p.count}`} />
					))}
				</Section>
			)}
			<Section title="Latest">
				{d.latest.map((e) => (
					<NodeRow key={e.id} node={e} onClick={() => onSelect(e)} />
				))}
			</Section>
		</>
	);
}

function Group({ d, onSelect }: { d: GroupDetail; onSelect: (n: Brief) => void }) {
	return (
		<>
			<p className="px-2 pt-3 text-sm text-muted-foreground">
				{d.episodes.length} episode{d.episodes.length === 1 ? '' : 's'}
				{d.first && ` · ${fmtDate(d.first)}`}
				{d.last && d.last !== d.first && ` → ${fmtDate(d.last)}`}
			</p>
			<Section title={d.type === 'sponsor' ? 'Sponsored' : 'Episodes'}>
				{d.episodes.map((e) => (
					<NodeRow key={e.id} node={e} onClick={() => onSelect(e)} />
				))}
			</Section>
		</>
	);
}
