# synthesis-graph — spec

Route planning for one target, **ibuprofen**, over a small reaction graph that grows through time.
The three industrial/academic routes are real and arrive on their real dates. The question the
app answers: _what is the best way to make ibuprofen, given what chemistry knew (and could buy)
in year X, and what happens if a supply line is cut?_

## Data (real chemistry, illustrative numbers)

| Route       | Since | Steps | Notes                                                                          |
| ----------- | ----- | ----- | ------------------------------------------------------------------------------ |
| Boots       | 1961  | 6     | FC acylation → Darzens → hydrolysis → oxime → nitrile → hydrolysis             |
| BHC         | 1992  | 3     | HF acylation → hydrogenation (Raney Ni) → Pd carbonylation (CO)                |
| Flow (2009) | 2009  | 3     | McQuade: FC (propionic acid, TfOH) → 1,2-aryl migration (PhI(OAc)₂) → saponify |
| Flow (2015) | 2015  | 3     | Jamison: same steps re-versioned — propionyl chloride / AlCl₃, ICl             |

Molecular weights are real, so **atom economy is computed, not typed in** (Boots ≈ 40 %, BHC ≈ 77 %,
the textbook numbers). Yields and prices are rounded, illustrative values; the README says so.

## Model

- `molecule` nodes: `name`, `formula`, `mw`, `price` ($/mol, `null` = not purchasable),
  `hazard` (`null` | text) and `severity` (`severe` | `none`, a string so `match` can `.where()` on it).
- `reaction` nodes: `name`, `route` (Boots | BHC | Flow), `yield`, `conditions`, `ref`.
- Edges: `reactant` molecule → reaction (`stoich`), `product` reaction → molecule,
  `catalyst` reaction → molecule (not consumed; hazards only).
- Weights: `reactant` 0, `product` = −ln(yield) — so a weighted `shortestPath` from a starting
  material to the target sums to −ln(yield along that chain).

History is **loaded with its own valid time** through `bulkLoad` / `bulkEdges` (explicit ids +
`validFrom`/`validTo`), so `asOf` is a calendar date. The 2015 flow update is a second version of
the same reaction nodes (new yield) and a closed/opened pair of reactant edges (propionic acid →
propionyl chloride, PhI(OAc)₂ → ICl).

## Algorithms

- **Best route** (`route.ts`, pure): AND/OR search over the asOf snapshot — a reaction needs _all_ its
  reactants, a molecule needs _one_ way in. Value iteration to a fixed point:
  - cost: `cost(m) = min(price, min_r (Σ stoich·cost(reactants)) / yield(r))`
  - steps: `steps(m) = 0 if purchasable, else min_r 1 + max steps(reactants)` (longest linear sequence)
  - avoid hazards: reactions whose reactants/catalysts are `severe` are skipped.
- **graphx algorithms**: `shortestPath` (hops ⇒ fewest steps from isobutylbenzene; weighted ⇒
  highest-yield chain), `match` (reactions using a severe hazard, asOf), `fork` (cut a supplier
  today; the branch re-plans).

## UI

Year scrubber (1955–2026) with event ticks · route card (steps, overall yield, cost/mol, atom
economy, step list) · network with the best route lit and not-yet-known chemistry ghosted ·
charts of best-route yield/atom economy and steps by year · objective + avoid-hazards controls ·
what-if supply cut (fork) with baseline vs branch side by side · graphx calls panel.

## Pieces

`src/catalog.ts` (data) · `schema.ts` · `src/route.ts` (AND/OR planner, pure) · `src/lab.ts` (graphx
reads/writes) · `server.ts` · `web/` · `lab.test.ts`.
