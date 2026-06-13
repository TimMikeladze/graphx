import { useMemo, useRef } from "react"
import { Cosmograph } from "@cosmograph/react"
import { ErrorBoundary } from "@/components/error-boundary"
import { type CosmoNode, legendOf, toCosmograph } from "@/lib/cosmograph-adapter"
import type { GraphSlice } from "@/lib/types"

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/** Cosmograph canvas fed by the governed graph slice (via the pure adapter). Click → select. */
export function GraphCanvas({
  slice,
  isLoading,
  selectedId,
  onSelect,
}: {
  slice?: GraphSlice
  isLoading?: boolean
  selectedId?: string
  onSelect: (id: string | undefined) => void
}) {
  const data = useMemo(
    () => (slice ? toCosmograph(slice, { selectedId }) : { nodes: [], links: [] }),
    [slice, selectedId],
  )
  // Resolve Cosmograph's click index → our node id without re-rendering.
  const pointsRef = useRef<CosmoNode[]>(data.nodes)
  pointsRef.current = data.nodes

  if (isLoading) return <Centered>Loading graph…</Centered>
  if (!slice || slice.nodes.length === 0) return <Centered>No graph for these filters.</Centered>

  return (
    <div className="relative h-full w-full bg-[#0b0b0f]">
      <ErrorBoundary fallback={<Centered>Graph canvas unavailable (WebGL required).</Centered>}>
        <Cosmograph
          points={data.nodes}
          pointIdBy="id"
          pointColorBy="color"
          pointColorByFn={(value: unknown) => String(value)}
          pointLabelBy="kind"
          links={data.links}
          linkSourceBy="source"
          linkTargetBy="target"
          backgroundColor="#0b0b0f"
          onClick={(index) =>
            onSelect(index === undefined ? undefined : pointsRef.current[index]?.id)
          }
          style={{ width: "100%", height: "100%" }}
        />
      </ErrorBoundary>
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-md bg-background/80 p-2 text-xs">
        {legendOf(slice).map((l) => (
          <div key={l.kind} className="flex items-center gap-2">
            <span className="inline-block size-3 rounded-full" style={{ backgroundColor: l.color }} />
            {l.kind}
          </div>
        ))}
      </div>
    </div>
  )
}
