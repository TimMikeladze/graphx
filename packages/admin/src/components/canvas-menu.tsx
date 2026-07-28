import { useEffect } from "react"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "@/lib/utils"

/** One entry of the canvas context menu. */
export interface CanvasMenuItem {
  label: string
  icon: IconSvgElement
  onSelect: () => void
  tone?: "default" | "destructive"
}

/** Where the menu was opened, in client coordinates. */
export interface CanvasMenuState {
  x: number
  y: number
  items: CanvasMenuItem[]
}

/**
 * The right-click menu on the flow canvas. Hand-rolled rather than pulled from a UI kit: it is
 * positioned at a pointer coordinate rather than anchored to a trigger element, which is the one
 * thing the trigger-based primitives do not do.
 */
export function CanvasMenu({
  state,
  onClose,
}: {
  state?: CanvasMenuState
  onClose: () => void
}) {
  useEffect(() => {
    if (!state) return
    const dismiss = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    // Any click (including on the canvas beneath) closes it, as does scrolling it out from under
    // the pointer.
    window.addEventListener("pointerdown", dismiss)
    window.addEventListener("wheel", dismiss)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("pointerdown", dismiss)
      window.removeEventListener("wheel", dismiss)
      window.removeEventListener("keydown", onKey)
    }
  }, [state, onClose])

  if (!state) return null

  return (
    <div
      role="menu"
      className="hud fixed z-50 min-w-40 p-1"
      style={{ left: state.x, top: state.y }}
      // The dismiss listener runs on the window, so keep the menu's own clicks from reaching it
      // before the item's handler does.
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
            item.tone === "destructive" && "text-destructive hover:bg-destructive/10",
          )}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          <HugeiconsIcon icon={item.icon} strokeWidth={2} className="size-3.5" />
          {item.label}
        </button>
      ))}
    </div>
  )
}
