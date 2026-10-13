# graphx.sh

The landing page and reference for [graphx.sh](https://graphx.sh), generated from the root `README.md`.
There's no framework and no bundler. The output is static files in `public/`, and they're committed.

```sh
bun install       # this directory has its own lockfile; it is not a workspace of the root
bun run build     # rewrites public/
bun run serve     # first free port from 4173 (PORT to change the start)
bun test          # every reference resolves, output equals a fresh render
```

## Where things live

- `content.ts` is the page model: copy, section order, which README example each section shows, links.
  No markup.
- `render.ts` (with `readme.ts`, `icons.ts`, `styles.ts`) resolves references and emits the HTML and every
  sibling artefact. No copy.
- `card.ts` draws `og.png` (satori + resvg, no browser) from the same model.
- `site.test.ts` is the drift guard.

**Authored copy lives in `content.ts`; examples never do.** `terminal("graphx doctor")` finds the README
fence whose first line is `$ graphx doctor`. `snippet("some unique line", "label")` finds the one fence
containing that line. A reference that matches zero or two blocks throws and fails the build, so
editing an example in the README breaks the build instead of leaving the page wrong. To add a section,
add an entry to `capabilities`.

`content.ts` also models the frame around the capability sections: split demo, figures, ecosystem band,
principles, tabbed showcase, guide cards, build-today band and mega-footer. Figures are counted from the
repo at build time (README tables, `###` sections, CLI lines, `dependencies`) and never typed. There are
no npm or GitHub figures because the project is pre-launch. Ecosystem marks come from `simple-icons`.

## Output (`public/`)

`index.html`, `reference.html` (the whole README behind a contents column), `index.md`, `reference.md`,
`llms.txt`, `AGENTS.md`, `sitemap.xml`, `robots.txt`, `favicon.svg`, `og.png`. `vercel.json` turns on
clean URLs and serves `public/`.

Two inline scripts ship. The theme boot in `<head>` reads the `graphx-theme` key and sets `data-theme`
before the stylesheet loads. A second, small one runs the header toggle, the footer's segmented theme
switch and the copy buttons. The hero's For humans / For agents switch and the showcase tabs are radio
inputs and need no script. With scripts off, the page is dark by default and follows the OS through a
`prefers-color-scheme` media query.

## Not done yet

- No analytics.
- No benchmark figures: the README holds no captured run to reference.
