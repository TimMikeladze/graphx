# synthesis-graph — route planning on graphx

How would you make ibuprofen in 1970? In 1995? Today, if HF and CO are off the table, or if your
acetic anhydride supplier drops out? Molecules and reactions form one graph, and every route enters
it on the date it was published. So each of those questions is a route planner run on a graphx read
**as of** a date, or on a **fork** of today's graph.

```sh
bun run server.ts   # loads the catalog into an in-memory graph, serves http://localhost:8930
bun test            # route flips by year, atom economy, reaction history, fork isolation
```

If 8930 is taken the server walks up to the next free port; it never stops what is already there.
One process: Bun bundles `web/index.html` itself.

## The chemistry

| Route | Since      | Steps | Atom economy | Notes                                                                                                  |
| ----- | ---------- | ----- | ------------ | ------------------------------------------------------------------------------------------------------ |
| Boots | 1961       | 6     | 40 %         | Friedel–Crafts → Darzens → hydrolysis → oxime → nitrile → hydrolysis                                   |
| BHC   | 1992       | 3     | 77 %         | HF acylation → hydrogenation (Raney Ni) → Pd carbonylation (CO)                                        |
| Flow  | 2009, 2015 | 3     | 39 %         | Friedel–Crafts → 1,2-aryl migration → saponification; the 2015 version swaps reagents and lifts yields |

Structures, molecular weights, routes and dates are real (Boots patent; BHC Bishop TX plant;
Bogdan et al. 2009; Snead & Jamison 2015). Atom economy is **computed** from the molecular weights,
and it comes out at the textbook 40 % / 77 %. Yields and $/mol prices are rounded, illustrative
figures: good for ranking routes, not for costing a plant.

## The graph

```
molecule ──reactant──▶ reaction ──product──▶ molecule     product weight = −ln(yield)
                       reaction ──catalyst─▶ molecule     not consumed; there for hazards
```

`src/catalog.ts` holds the data. `loadCatalog` writes it with **its own valid time** through
`bulkLoad` / `bulkEdges` (explicit ids plus `validFrom` / `validTo`), so `asOf` is a calendar date.
The 2015 flow update becomes a second version of the same reaction nodes, plus closed and opened
reactant edges (PhI(OAc)₂ → ICl).

## The planner

A synthesis graph is AND/OR: a reaction needs **all** its reactants, while a molecule needs only
**one** way in. Shortest path can't price that, so `src/route.ts` (pure, no graphx) runs value
iteration on the snapshot:

```
cost(m)  = min(price, min over r → m of Σ stoich · cost(reactant) / yield(r))
steps(m) = 0 if bought, else min over r → m of 1 + max steps(reactant)
```

It has two objectives (cheapest, fewest steps) and an "avoid severe hazards" filter.

## Where graphx comes in

| Question                                  | graphx (`src/lab.ts`)                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| What did chemistry know in year X?        | `g.listNodes({ asOf })`, `g.listEdges({ asOf })` → planner                 |
| When did each route arrive, what changed? | `bulkLoad` with explicit intervals; `diff(db, t1, t2)`                     |
| How did one reaction evolve?              | `history(db, 'F2')`: 2009 PhI(OAc)₂ 70 % → 2015 ICl 92 %                   |
| Fewest hops / least-loss straight chain   | `shortestPath(..., { asOf, weighted })` (one chain, ignores co-reactants)  |
| Which steps use HF, CO or Raney Ni?       | `match(...).where('m', 'severity', 'severe').asOf(at)`                     |
| What if a supplier drops out?             | `g.fork(branchDb)` then `branch.updateNode(id, { data: { price: null } })` |

Things the app shows:

- In 1992 the cheapest route flips from Boots to BHC.
- With severe hazards avoided, flow only wins **after its 2015 version**: the 2009 version existed
  but cost more than Boots.
- Cut acetic anhydride in a fork and today's plan moves from BHC to flow. The baseline doesn't
  change, and neither does the fork's own past.

## Files

- `src/catalog.ts`: the chemistry, with dates.
- `schema.ts`: the graphx schema.
- `src/route.ts`: the AND/OR planner, pure.
- `src/lab.ts`: every graphx read and write.
- `server.ts`: Bun server with five JSON routes.
- `web/`: React UI. `charts.tsx` is the only module that imports TanStack Charts.
