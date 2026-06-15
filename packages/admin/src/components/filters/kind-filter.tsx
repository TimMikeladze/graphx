import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const ALL = "__all__"

/** Node-kind selector. Options are the kinds present in the current slice (plus the active kind). */
export function KindFilter({
  value,
  kinds,
  onChange,
}: {
  value?: string
  kinds: string[]
  onChange: (kind: string | undefined) => void
}) {
  const options = [...new Set([...(value ? [value] : []), ...kinds])].sort()
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? undefined : v)}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="All kinds" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All kinds</SelectItem>
        {options.map((k) => (
          <SelectItem key={k} value={k}>
            {k}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
