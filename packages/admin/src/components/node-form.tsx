import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { FormField, FormValues } from "@/lib/json-schema-form"
import { cn } from "@/lib/utils"

/** A field's inline validation message (from the form engine, or the server's 400). */
function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-xs text-destructive">{message}</p>
}

function FieldHint({ field }: { field: FormField }) {
  if (field.description) return <p className="text-xs text-muted-foreground">{field.description}</p>
  if (field.defaultValue !== undefined)
    return (
      <p className="text-xs text-muted-foreground">
        Defaults to <code className="font-mono">{JSON.stringify(field.defaultValue)}</code>
      </p>
    )
  return null
}

/** One field, rendered per its kind: scalars as inputs, anything richer as JSON source. */
function FieldControl({
  field,
  value,
  invalid,
  onChange,
}: {
  field: FormField
  value: string
  invalid: boolean
  onChange: (next: string) => void
}) {
  const id = `field-${field.name}`
  const ring = invalid ? "border-destructive focus-visible:ring-destructive/30" : undefined

  if (field.kind === "enum" || field.kind === "boolean") {
    const options = field.kind === "boolean" ? ["true", "false"] : (field.options ?? [])
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className={cn("w-full", ring)}>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  if (field.kind === "json") {
    return (
      <Textarea
        id={id}
        spellCheck={false}
        rows={3}
        className={cn("font-mono text-xs", ring)}
        placeholder="JSON value"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  return (
    <Input
      id={id}
      className={ring}
      inputMode={field.kind === "string" ? undefined : "decimal"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** The generated part of the node editor: one control per declared property. */
export function NodeFields({
  fields,
  values,
  errors,
  onChange,
}: {
  fields: FormField[]
  values: FormValues
  errors: Record<string, string>
  onChange: (name: string, next: string) => void
}) {
  return (
    <div className="grid gap-3">
      {fields.map((field) => (
        <div key={field.name} className="grid gap-1.5">
          <Label htmlFor={`field-${field.name}`} className="font-mono text-xs">
            {field.name}
            {field.required && <span className="text-destructive"> *</span>}
          </Label>
          <FieldControl
            field={field}
            value={values[field.name] ?? ""}
            invalid={Boolean(errors[field.name])}
            onChange={(next) => onChange(field.name, next)}
          />
          {errors[field.name] ? <FieldError message={errors[field.name]} /> : <FieldHint field={field} />}
        </div>
      ))}
    </div>
  )
}

/**
 * The fallback editor: the whole `data` object as JSON. Used when the type declares no properties
 * (an open record), or when the schema could not be fetched at all.
 */
export function RawDataField({
  value,
  error,
  onChange,
  hint,
}: {
  value: string
  error?: string
  onChange: (next: string) => void
  hint?: string
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="field-data" className="font-mono text-xs">
        data
      </Label>
      <Textarea
        id="field-data"
        spellCheck={false}
        rows={8}
        className={cn("font-mono text-xs", error && "border-destructive focus-visible:ring-destructive/30")}
        placeholder="{}"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <FieldError message={error} /> : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
