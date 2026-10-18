# MTG graph canvas

Replace the fixed SVG graph with a card-based relationship workspace. Keep the existing Next.js app, GraphX data, card detail drawer, and monochrome surfaces. Card art uses the existing cached Scryfall image route; missing images retain a readable card fallback.

## Behavior

- A React Flow canvas supports unlimited pan, wheel panning, pinch zoom, draggable nodes, keyboard navigation, fit-to-view, a minimap, and fullscreen. Cards render at their card aspect ratio; features render as compact labeled nodes. Connections use persisted relation types and inspectable evidence.
- Start with roles, keywords, and subtypes. Filter relationship types, card name/rules text, color, type, format, and maximum mana value. Keep the root visible, remove disconnected features/cards, and report visible/loaded counts. A cards-only mode projects shared features into labeled card-to-card connections, explicitly described as shared evidence.
- Click selects without replacing the root. The inspector previews the selected card or feature, lists its connected nodes and relation evidence, and offers card details, expansion, or making a card the root. Expansion merges and deduplicates bounded neighborhoods. Changing the root resets expansion; filters retain positions.
- Search selects a root or path destination. Shortest paths appear on the canvas with their persisted edges, including paths outside the original neighborhood. Empty results, traversal limits, errors, and loading are visible.
- Desktop uses a large canvas with a collapsible inspector. Phone controls wrap and the inspector sits below the canvas. Fullscreen keeps controls and inspector usable.

## Implementation order

1. Add typed graph payloads with card data, relation-aware bounded neighbors, and renderable shortest paths. Test filtered neighborhoods, disconnected candidates, and path edge integrity against in-memory GraphX databases.
2. Add graph projection/filter/layout helpers with tests for shared-evidence links, combined filters, deduplicated expansion, and bounded output. Use React Flow for canvas interactions and custom card/feature nodes.
3. Replace the graph view, add canvas styles, and document controls and API additions. Preserve unrelated workspace changes already present.
4. Run the example tests, type-check, lint, production build, and repository tests. Verify card images, selection, filtering, expansion, paths, pan/zoom, and phone layout in the browser. Record actual verification.

Canvas operations only read persisted graph data. Dragging nodes changes the current layout, and projected links never claim a persisted card-to-card relation or verified combo. Cap a loaded canvas at 240 nodes; explain the cap when reached.

React Flow custom node and canvas APIs: https://reactflow.dev/learn/customization/custom-nodes and https://reactflow.dev/api-reference/react-flow.

## Verified behavior

Browser checks against the local app on port 8795 cover loaded card images, selection without changing the root, expansion, text/color/relationship filtering, empty results, and switching between cards and features. Further checks cover keyboard edge selection, zoom controls, background panning, card dragging, rendered shortest paths, clearing paths, and expanded workspace/Escape.

A throttled response confirmed that canceling path mode cannot restore an old path. Overlapping an expansion with a newer path confirmed that the older expansion cannot erase the path result. The projection regression test removes cards left disconnected after filtering an expanded hub.

At 390 × 844, the canvas remains available without horizontal page overflow, color filters reduce the visible graph, and card selection updates the inspector below the canvas. Screenshots and local check scripts are in the example's ignored `artifacts/graph-canvas/` directory.

The 33 existing-domain and graph tests pass. The graph source and graph tests pass TypeScript checking, and the changed graph files pass oxlint and formatting checks. The latest repository run passed 1,607 tests with 11 skipped and no failures. A production build passed before concurrent catalog changes were added. Full-project type-checking is currently blocked by those changing files: `src/runtime.ts` imports the missing `library-graph` module and accesses `coverage` on a broader node union; `tests/library.test.ts` imports the same missing module, and `tests/download.test.ts:41` passes an incompatible typed array to `Response`. The latest build stopped on the catalog test types. Logs are in `artifacts/graph-canvas/`. No unfinished catalog files were changed as part of the graph redesign.
