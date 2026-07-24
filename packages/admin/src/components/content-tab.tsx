import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  AlertCircleIcon,
  Edit02Icon,
  File01Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import { EmptyState } from "@/components/empty-state"
import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useNodeContent, useUpdateNodeBody } from "@/hooks/use-graph"
import { ApiError } from "@/lib/api"

/**
 * Unsaved edits, keyed by node id, surviving a selection change. Module-level rather than a
 * confirm() guard: the inspector is a click away from every node in the canvas, so an accidental
 * selection must not be able to destroy typing. Drafts are session-only (a reload drops them,
 * which `beforeunload` warns about).
 */
const drafts = new Map<string, string>()

const errMsg = (e: unknown) =>
  e instanceof ApiError && e.status === 403
    ? "Read-only — your role can't edit nodes."
    : e instanceof Error
      ? e.message
      : String(e)

/** Provenance line for ingest-sourced bodies — edits here lose to the next re-ingest of the file. */
function SourceWarning({ uri }: { uri: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[0.7rem] text-muted-foreground">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} className="mt-px size-3 shrink-0" />
      <span>
        Synced from <span className="font-mono">{uri}</span> — edits are overwritten when the
        source file changes and is re-ingested.
      </span>
    </p>
  )
}

/**
 * The selected node's markdown body — rendered, and editable in place. Saving `PATCH`es the node,
 * which the server records as a new bitemporal version (visible in the History tab).
 *
 * The write does NOT re-embed: `emb`/`embed_hash` carry forward, so vector and hybrid search keep
 * matching the pre-edit text until the node is re-ingested. That is surfaced after a save rather
 * than hidden.
 */
export function ContentTab({
  tenant,
  project,
  nodeId,
  active,
}: {
  tenant: string
  project: string
  nodeId: string
  /** The tab is open — gates the fetch so selecting a node doesn't pull its body. */
  active: boolean
}) {
  const content = useNodeContent(tenant, project, nodeId, active)
  const save = useUpdateNodeBody(tenant, project, nodeId)
  // `null` ⇒ viewing; a string ⇒ editing, holding the working source.
  const [draft, setDraft] = useState<string | null>(() => drafts.get(nodeId) ?? null)
  const [savedThisSession, setSavedThisSession] = useState(false)

  // Swap in the newly selected node's draft (or drop to view mode when it has none). Adjusted
  // during render rather than in an effect — the state derives from a prop, so an effect would
  // paint the previous node's draft for a frame first.
  const [renderedFor, setRenderedFor] = useState(nodeId)
  if (renderedFor !== nodeId) {
    setRenderedFor(nodeId)
    setDraft(drafts.get(nodeId) ?? null)
    setSavedThisSession(false)
  }

  const body = content.data?.body ?? ""
  const dirty = draft !== null && draft !== body

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  function edit(next: string | null) {
    if (next === null) drafts.delete(nodeId)
    else drafts.set(nodeId, next)
    setDraft(next)
  }

  function commit() {
    if (draft === null || save.isPending) return
    save.mutate(draft, {
      onSuccess: () => {
        edit(null)
        setSavedThisSession(true)
        toast.success("Content saved — new version")
      },
      onError: (e) => toast.error(errMsg(e)),
    })
  }

  if (content.isLoading)
    return (
      <div className="flex flex-col gap-2 p-1">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  if (content.isError)
    return <EmptyState icon={AlertCircleIcon} tone="destructive" title="Failed to load content" />

  const uri = content.data?.uri

  if (draft !== null)
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        {uri && <SourceWarning uri={uri} />}
        <Textarea
          autoFocus
          spellCheck={false}
          value={draft}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault()
              commit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              if (!dirty || window.confirm("Discard unsaved changes?")) edit(null)
            }
          }}
          placeholder="# Markdown…"
          className="h-full min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed [field-sizing:fixed]"
        />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[0.7rem] text-muted-foreground">
            {dirty ? "Unsaved changes · ⌘S to save" : "No changes"}
          </span>
          <Button variant="ghost" size="sm" onClick={() => edit(null)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={commit} disabled={!dirty || save.isPending}>
            {save.isPending && (
              <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="animate-spin" />
            )}
            Save
          </Button>
        </div>
      </div>
    )

  if (!body)
    return (
      <EmptyState
        icon={File01Icon}
        title="No content"
        hint={
          uri
            ? `Sourced from ${uri}, but the body is empty.`
            : "This node has no markdown body yet."
        }
        action={
          <Button size="sm" onClick={() => edit("")}>
            Add content
          </Button>
        }
      />
    )

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          {uri && <SourceWarning uri={uri} />}
          {savedThisSession && (
            <p className="text-[0.7rem] text-muted-foreground">
              Saved. Vector and hybrid search still match the pre-edit text until this node is
              re-embedded.
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => edit(body)}>
          <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} data-icon="inline-start" />
          Edit
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1 pr-2">
        <Markdown>{body}</Markdown>
      </ScrollArea>
    </div>
  )
}
