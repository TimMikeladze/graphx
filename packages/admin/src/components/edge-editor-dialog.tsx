import { useMemo, useState } from "react"
import { toast } from "sonner"
import { NodeFields, RawDataField } from "@/components/node-form"
import { TypeDot } from "@/components/type-dot"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useCreateEdge, useSchema } from "@/hooks/use-graph"
import { noRelReason, relsFor } from "@/lib/edge-rels"
import {
  fieldsOf,
  initialValues,
  parseJsonObject,
  parseValues,
  type FormValues,
} from "@/lib/json-schema-form"
import { shortId } from "@/lib/format"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The two nodes an edge is being drawn between, as the canvas knows them. */
export interface PendingEdge {
  source: string
  target: string
  sourceType?: string
  targetType?: string
  sourceLabel?: string
  targetLabel?: string
}

/** One endpoint, shown read-only: the canvas already decided which nodes these are. */
function Endpoint({ label, type, id }: { label?: string; type?: string; id: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5">
      {type && <TypeDot type={type} />}
      <span className="truncate text-xs font-medium">{label ?? shortId(id, 8, 6)}</span>
      {type && <span className="shrink-0 text-[0.65rem] text-muted-foreground">{type}</span>}
    </div>
  )
}

/**
 * Create an edge between two nodes. There is no edit: the server has no `PATCH /edges`, so
 * changing a relation means deleting it and drawing it again.
 *
 * The rel choices are filtered to those whose declared endpoint types accept this pair, and the
 * per-rel data schema (when it has one) generates the same kind of form the node editor uses.
 */
export function EdgeEditorDialog({
  tenant,
  project,
  pending,
  onOpenChange,
}: {
  tenant: string
  project: string
  /** The edge being drawn; absent ⇒ closed. */
  pending?: PendingEdge
  onOpenChange: (open: boolean) => void
}) {
  const schema = useSchema(tenant, project)
  const create = useCreateEdge(tenant, project)

  const candidates = useMemo(
    () => relsFor(schema.data?.edges ?? [], pending?.sourceType, pending?.targetType),
    [schema.data, pending?.sourceType, pending?.targetType],
  )
  const blocked = noRelReason(schema.data?.edges ?? [], pending?.sourceType, pending?.targetType)

  const [rel, setRel] = useState("")
  const [weight, setWeight] = useState("")
  const [values, setValues] = useState<FormValues>({})
  const [raw, setRaw] = useState("{}")
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Reload when the dialog opens on a different pair, or the schema lands after it opened.
  const subject = pending
    ? `${pending.source}->${pending.target}:${schema.dataUpdatedAt}`
    : "closed"
  const [loadedFor, setLoadedFor] = useState(subject)
  if (loadedFor !== subject) {
    setLoadedFor(subject)
    if (pending) {
      const first = candidates[0]?.rel ?? ""
      setRel(first)
      setValues(initialValues(fieldsOf(candidates[0]?.jsonSchema ?? undefined)))
      setWeight("")
      setRaw("{}")
      setErrors({})
    }
  }

  const relSchema = candidates.find((c) => c.rel === rel)?.jsonSchema ?? undefined
  const fields = useMemo(() => fieldsOf(relSchema), [relSchema])
  // A rel with no data schema takes no data at all — offer neither a form nor a JSON box.
  const hasData = relSchema !== undefined && relSchema !== null

  function pickRel(next: string) {
    setRel(next)
    setValues(initialValues(fieldsOf(candidates.find((c) => c.rel === next)?.jsonSchema ?? undefined)))
    setErrors({})
  }

  function submit() {
    if (!pending || create.isPending) return
    if (rel === "") {
      setErrors({ rel: "Required" })
      return
    }

    let data: Record<string, unknown> | undefined
    if (hasData) {
      const parsed = fields.length === 0 ? parseJsonObject(raw) : parseValues(fields, values)
      if (!parsed.data) {
        setErrors(parsed.errors)
        return
      }
      data = Object.keys(parsed.data).length > 0 ? parsed.data : undefined
    }

    const trimmedWeight = weight.trim()
    if (trimmedWeight !== "") {
      const n = Number(trimmedWeight)
      if (!Number.isFinite(n) || n < 0) {
        setErrors({ weight: "Must be zero or more" })
        return
      }
    }

    setErrors({})
    create.mutate(
      {
        rel,
        src: pending.source,
        dst: pending.target,
        weight: trimmedWeight === "" ? undefined : Number(trimmedWeight),
        data,
      },
      {
        onSuccess: () => {
          toast.success(`Edge created — ${rel}`)
          onOpenChange(false)
        },
        onError: (e) => setErrors({ form: errMsg(e) }),
      },
    )
  }

  return (
    <Dialog open={pending !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New edge</DialogTitle>
          <DialogDescription>
            Relations are directed. Only those whose declared endpoints accept this pair are
            offered.
          </DialogDescription>
        </DialogHeader>

        {pending && (
          <ScrollArea className="max-h-[60vh] pr-3">
            <div className="grid gap-3">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <Endpoint
                  label={pending.sourceLabel}
                  type={pending.sourceType}
                  id={pending.source}
                />
                <span aria-hidden className="text-muted-foreground">
                  →
                </span>
                <Endpoint
                  label={pending.targetLabel}
                  type={pending.targetType}
                  id={pending.target}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="edge-rel">Relation</Label>
                {blocked ? (
                  <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                    {blocked}
                  </p>
                ) : (
                  <Select value={rel} onValueChange={pickRel}>
                    <SelectTrigger id="edge-rel" className="w-full">
                      <SelectValue placeholder="Choose a relation…" />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((c) => (
                        <SelectItem key={c.rel} value={c.rel}>
                          {c.rel}
                          {c.single && " · single"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {errors.rel && <p className="text-xs text-destructive">{errors.rel}</p>}
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="edge-weight">Weight</Label>
                <Input
                  id="edge-weight"
                  inputMode="decimal"
                  placeholder="1"
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                />
                {errors.weight ? (
                  <p className="text-xs text-destructive">{errors.weight}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Optional. Drives edge thickness on the canvas.
                  </p>
                )}
              </div>

              {hasData &&
                (fields.length === 0 ? (
                  <RawDataField
                    value={raw}
                    error={errors.data}
                    onChange={setRaw}
                    hint="This relation declares no fixed properties."
                  />
                ) : (
                  <NodeFields
                    fields={fields}
                    values={values}
                    errors={errors}
                    onChange={(name, next) => setValues((v) => ({ ...v, [name]: next }))}
                  />
                ))}
            </div>
          </ScrollArea>
        )}

        {errors.form && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errors.form}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || Boolean(blocked)}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
