import { useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react"
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react"
import {
  ChartRelationshipIcon,
  Delete02Icon,
  NodeAddIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons"
import { CanvasMenu, type CanvasMenuState } from "@/components/canvas-menu"
import { EmptyState } from "@/components/empty-state"
import { useTheme } from "@/components/theme-provider"
import { FlowNode } from "@/components/flow-node"
import { Button } from "@/components/ui/button"
import {
  exceedsFlowCap,
  FLOW_MAX_NODES,
  layoutFlow,
  toFlow,
  type FlowNodeData,
  type GraphFlowNode,
} from "@/lib/flow-adapter"
import { FlowLabelSourceContext } from "@/lib/flow-label-source"
import type { LabelSettings } from "@/lib/graph-style"
import type { FlowLayout, GraphSlice, RendererHandle } from "@/lib/types"
import "@xyflow/react/dist/style.css"

/** Module-level: xyflow warns (and remounts every node) if this identity changes between renders. */
const NODE_TYPES = { graphNode: FlowNode }

/** Arrowheads — the DOM renderer can show edge direction, which the WebGL canvas cannot. */
const DEFAULT_EDGE_OPTIONS = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
}

/** Layout is measured from the DOM, so a fit issued in the same frame would frame stale boxes. */
const FIT_AFTER_LAYOUT_MS = 60

export interface FlowCanvasProps {
  slice: GraphSlice
  selectedId?: string
  onSelect: (id: string | undefined) => void
  labels: LabelSettings
  layout: FlowLayout
  /** Offered when the slice is past {@link FLOW_MAX_NODES} — the only renderer that can draw it. */
  onSwitchToCosmograph: () => void
  handleRef: React.RefObject<RendererHandle | null>
  /** Editing entry points. Absent ⇒ that action is left out of the right-click menu. */
  onCreateNode?: () => void
  onEditNode?: (id: string) => void
  onDeleteNode?: (id: string) => void
}

/** xyflow renderer: DOM cards on a computed layout. Sibling of the Cosmograph `GraphCanvas`. */
export function FlowCanvas(props: FlowCanvasProps) {
  if (exceedsFlowCap(props.slice)) {
    return (
      <EmptyState
        icon={ChartRelationshipIcon}
        title={`${props.slice.nodes.length.toLocaleString()} nodes is too many to draw as cards`}
        hint={`The flow renderer stops at ${FLOW_MAX_NODES}. Narrow the filters, or switch back to the force canvas, which is built for slices this size.`}
        action={
          <Button variant="outline" size="sm" onClick={props.onSwitchToCosmograph}>
            Switch to force canvas
          </Button>
        }
      />
    )
  }
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function FlowCanvasInner({
  slice,
  selectedId,
  onSelect,
  labels,
  layout,
  handleRef,
  onCreateNode,
  onEditNode,
  onDeleteNode,
}: FlowCanvasProps) {
  const flow = useReactFlow<GraphFlowNode>()
  // The app's own provider only reports the *chosen* theme; `system` is xyflow's to resolve.
  const { theme } = useTheme()

  // Structure and placement are memoized apart: toggling edge labels must not re-run the layout,
  // and switching layouts must not rebuild the cards.
  const structure = useMemo(() => toFlow(slice, { showEdgeLabels: labels.edges }), [
    slice,
    labels.edges,
  ])
  const placed = useMemo(() => layoutFlow(structure, layout), [structure, layout])

  const [nodes, setNodes, onNodesChange] = useNodesState<GraphFlowNode>(placed.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(placed.edges)

  // New slice or new layout: adopt the placement and frame it.
  useEffect(() => {
    setNodes(placed.nodes)
    setEdges(placed.edges)
    const t = setTimeout(() => flow.fitView({ padding: 0.2, duration: 300 }), FIT_AFTER_LAYOUT_MS)
    return () => clearTimeout(t)
  }, [placed, setNodes, setEdges, flow])

  // Selection is owned by the URL, so it arrives as a prop from anywhere (list, palette, detail).
  useEffect(() => {
    setNodes((current) =>
      current.map((n) =>
        n.selected === (n.id === selectedId) ? n : { ...n, selected: n.id === selectedId },
      ),
    )
    if (selectedId === undefined) return
    const t = setTimeout(
      () => flow.fitView({ nodes: [{ id: selectedId }], padding: 0.6, maxZoom: 1.2, duration: 400 }),
      FIT_AFTER_LAYOUT_MS,
    )
    return () => clearTimeout(t)
  }, [selectedId, setNodes, flow])

  // Right-click menu: node actions on a card, create on empty canvas. DOM rendering is what makes
  // this possible here and not on the WebGL canvas.
  const [menu, setMenu] = useState<CanvasMenuState | undefined>(undefined)
  const closeMenu = useCallback(() => setMenu(undefined), [])

  const openNodeMenu = useCallback(
    (event: React.MouseEvent, id: string) => {
      const items = [
        ...(onEditNode
          ? [{ label: "Edit node", icon: PencilEdit02Icon, onSelect: () => onEditNode(id) }]
          : []),
        ...(onDeleteNode
          ? [
              {
                label: "Retract node",
                icon: Delete02Icon,
                tone: "destructive" as const,
                onSelect: () => onDeleteNode(id),
              },
            ]
          : []),
      ]
      if (items.length === 0) return
      event.preventDefault()
      // Selecting first keeps the menu and the rest of the app talking about the same node.
      onSelect(id)
      setMenu({ x: event.clientX, y: event.clientY, items })
    },
    [onDeleteNode, onEditNode, onSelect],
  )

  const openPaneMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      if (!onCreateNode) return
      event.preventDefault()
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [{ label: "New node", icon: NodeAddIcon, onSelect: onCreateNode }],
      })
    },
    [onCreateNode],
  )

  useImperativeHandle(
    handleRef,
    () => ({
      fit: () => flow.fitView({ padding: 0.2, duration: 400 }),
      zoomIn: () => flow.zoomIn({ duration: 300 }),
      zoomOut: () => flow.zoomOut({ duration: 300 }),
    }),
    [flow],
  )

  return (
    <FlowLabelSourceContext value={labels.source}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        colorMode={theme}
        // Dragging a card is local-only scratch work; connecting is the editing story, not this one.
        nodesConnectable={false}
        minZoom={0.05}
        maxZoom={2.5}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(undefined)}
        onNodeContextMenu={(e, node) => openNodeMenu(e, node.id)}
        onPaneContextMenu={openPaneMenu}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => (n.data as FlowNodeData).color}
          nodeStrokeWidth={0}
          className="rounded-lg border"
        />
      </ReactFlow>
      <CanvasMenu state={menu} onClose={closeMenu} />
    </FlowLabelSourceContext>
  )
}
