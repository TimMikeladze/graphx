import { useMemo, useState } from "react"
import { toast } from "sonner"
import { NodeFields, RawDataField } from "@/components/node-form"
import { NodeTypeBadge } from "@/components/type-dot"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useCreateNode, useSchema, useUpdateNode } from "@/hooks/use-graph"
import {
  fieldsOf,
  initialValues,
  parseJsonObject,
  parseValues,
  type FormValues,
} from "@/lib/json-schema-form"
import type { GraphNode, JsonSchema } from "@/lib/types"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Create or edit a node. The form is generated from the project's declared schema
 * (`GET /schema`); a type whose schema declares no properties — or a project whose schema could
 * not be read — falls back to editing `data` as JSON.
 *
 * Editing does not offer the type: `PATCH` accepts one, but changing it re-validates the data
 * against a different schema and drops foreign fields, which is a migration, not an edit.
 */
export function NodeEditorDialog({
  tenant,
  project,
  open,
  onOpenChange,
  nodeId,
  node,
  onCreated,
}: {
  tenant: string
  project: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The node being edited; absent ⇒ creating. */
  nodeId?: string
  /** That node, once it has loaded. */
  node?: GraphNode
  /** Called with the new node's id after a successful create (the explorer selects it). */
  onCreated?: (id: string) => void
}) {
  const schema = useSchema(tenant, project)
  const create = useCreateNode(tenant, project)
  const update = useUpdateNode(tenant, project, nodeId)
  const editing = nodeId !== undefined
  /**
   * The form waits for what it is generated from.
   *
   * Two races, both real on a cold open: an edit reached from the canvas menu can beat the node
   * fetch, and the schema query starts when the first dialog mounts. Rendering anyway would show
   * an edit as a create form for a frame, and — worse — let the user start typing into a
   * schema-less fallback that is then reset the moment the schema lands.
   */
  const loading = (editing && node === undefined) || schema.isPending
  const pending = create.isPending || update.isPending

  const declaredTypes = schema.data?.nodes ?? []
  const schemaOf = (type: string): JsonSchema | undefined =>
    declaredTypes.find((n) => n.type === type)?.jsonSchema

  const [type, setType] = useState(node?.type ?? "")
  const [values, setValues] = useState<FormValues>({})
  const [raw, setRaw] = useState("{}")
  const [body, setBody] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Reload the form whenever the dialog opens on a different subject, or the schema arrives after
  // it opened. Adjusted during render rather than in an effect, so the dialog never paints one
  // frame of the previous node's values (the pattern the Content tab uses).
  const subject = open ? `${node?.id ?? nodeId ?? "new"}:${schema.dataUpdatedAt}:${loading}` : "closed"
  const [loadedFor, setLoadedFor] = useState(subject)
  if (loadedFor !== subject) {
    setLoadedFor(subject)
    if (open && !loading) {
      const nextType = node?.type ?? declaredTypes[0]?.type ?? ""
      setType(nextType)
      setValues(initialValues(fieldsOf(schemaOf(nextType)), node?.data))
      setRaw(JSON.stringify(node?.data ?? {}, null, 2))
      setBody("")
      setErrors({})
    }
  }

  const fields = useMemo(
    () => fieldsOf(schema.data?.nodes.find((n) => n.type === type)?.jsonSchema),
    [schema.data, type],
  )
  // No declared properties (an open record, an unknown type, or no schema at all) — edit JSON.
  const rawMode = fields.length === 0

  function pickType(next: string) {
    setType(next)
    setValues(initialValues(fieldsOf(schemaOf(next)), node?.data))
    setErrors({})
  }

  function submit() {
    if (pending) return
    if (!editing && type.trim() === "") {
      setErrors({ type: "Required" })
      return
    }
    const parsed = rawMode ? parseJsonObject(raw) : parseValues(fields, values)
    if (!parsed.data) {
      setErrors(parsed.errors)
      return
    }
    setErrors({})

    if (editing) {
      update.mutate(
        { data: parsed.data },
        {
          onSuccess: () => {
            toast.success("Node updated — new version")
            onOpenChange(false)
          },
          // The server is the authority on the schema; surface its rejection verbatim.
          onError: (e) => setErrors({ form: errMsg(e) }),
        },
      )
      return
    }

    create.mutate(
      { type: type.trim(), data: parsed.data, body: body.trim() === "" ? undefined : body },
      {
        onSuccess: (created) => {
          toast.success("Node created")
          onOpenChange(false)
          onCreated?.(created.id)
        },
        onError: (e) => setErrors({ form: errMsg(e) }),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit node" : "New node"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Saving opens a new version; the previous one stays readable in History. Blank fields keep their current value — patches merge."
              : "Fields come from the project's declared schema. The server validates on save."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid gap-2 py-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : (
        <ScrollArea className="max-h-[60vh] pr-3">
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="node-type">Type</Label>
              {node ? (
                <div className="flex h-9 items-center">
                  <NodeTypeBadge type={node.type} />
                </div>
              ) : declaredTypes.length > 0 ? (
                <Select value={type} onValueChange={pickType}>
                  <SelectTrigger id="node-type" className="w-full">
                    <SelectValue placeholder="Choose a type…" />
                  </SelectTrigger>
                  <SelectContent>
                    {declaredTypes.map((n) => (
                      <SelectItem key={n.type} value={n.type}>
                        {n.type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <input
                  id="node-type"
                  className="flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  placeholder="person"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                />
              )}
              {errors.type && <p className="text-xs text-destructive">{errors.type}</p>}
            </div>

            {rawMode ? (
              <RawDataField
                value={raw}
                error={errors.data}
                onChange={setRaw}
                hint={
                  schema.isError
                    ? "The schema could not be read, so data is edited as JSON."
                    : "This type declares no fixed properties."
                }
              />
            ) : (
              <NodeFields
                fields={fields}
                values={values}
                errors={errors}
                onChange={(name, next) => setValues((v) => ({ ...v, [name]: next }))}
              />
            )}

            {/* Editing a body has its own home in the detail panel's Content tab. */}
            {!editing && (
              <div className="grid gap-1.5">
                <Label htmlFor="node-body">Content</Label>
                <Textarea
                  id="node-body"
                  rows={4}
                  placeholder="Optional markdown body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>
            )}
          </div>
        </ScrollArea>
        )}

        {errors.form && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errors.form}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || loading}>
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
