# graphx.sh

The landing page and reference for [graphx.sh](https://graphx.sh), generated from the root `README.md`.
No framework and no bundler; the output is static files in `public/`, committed.

```sh
bun install       # this directory has its own lockfile — it is not a workspace of the root
bun run build     # rewrites public/
bun run serve     # first free port from 4173 (PORT to change the start)
bun test          # every reference resolves, output equals a fresh render
```

## Shape

- `content.ts` — the page model: copy, section order, which README example each section shows, links.
  No markup.
- `render.ts` (+ `readme.ts`, `icons.ts`, `styles.ts`) — resolves references, emits the HTML and every
  sibling artefact. No copy.
- `card.ts` — draws `og.png` (satori + resvg, no browser) from the same model.
- `site.test.ts` — the drift guard.

**Authored copy lives in `content.ts`; examples never do.** `terminal("graphx doctor")` finds the README
fence whose first line is `$ graphx doctor`; `snippet("some unique line", "label")` finds the one fence
containing that line. A reference that matches zero or two blocks throws and fails the build, so
editing an example in the README breaks the build instead of leaving the page wrong. Add a section by
adding an entry to `capabilities`.

The frame around the capability sections — split demo, figures, ecosystem band, principles, tabbed
showcase, guide cards, build-today band, mega-footer — is also modelled in `content.ts`. Figures are
counted from the repo at build time (README tables, `###` sections, CLI lines, `dependencies`), never
typed; there are no npm/GitHub figures because the project is pre-launch. Ecosystem marks come from
`simple-icons`.

## Output (`public/`)

`index.html`, `reference.html` (the whole README behind a contents column), `index.md`, `reference.md`,
`llms.txt`, `AGENTS.md`, `sitemap.xml`, `robots.txt`, `favicon.svg`, `og.png`. `vercel.json` turns on
clean URLs and serves `public/`.

Two inline scripts ship: the theme boot in `<head>` (key `graphx-theme`, sets `data-theme` before the
stylesheet) and a small one for the header toggle, the footer's segmented theme switch and copy buttons.
The hero's For humans / For agents switch and the showcase tabs are radio inputs — no script. Without them the page is dark by
default and follows the OS through a `prefers-color-scheme` media query.

## Not done yet

- No analytics.
- No benchmark figures: the README holds no captured run to reference.
