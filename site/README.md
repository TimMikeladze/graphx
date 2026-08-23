# graphx.sh

The landing page for [graphx.sh](https://graphx.sh). Vite, no framework, no client-side markdown.

```sh
bun install   # this directory has its own lockfile — it is not a workspace of the root
bun run dev   # http://localhost:5173
bun run build # → dist/
```

## How it works

The repo's `README.md` is the only source of content. At build time `prerender.ts` reads it and
emits static HTML — the hero title, tagline and install command, the section rail, and the whole
docs body, with code highlighted by [shiki](https://shiki.style) at build time. The browser
downloads no markdown parser and no highlighter; `src/main.ts` only wires up the theme toggle, the
copy buttons, the tabs and the scroll spy (2.8 kB before gzip).

Editing `../README.md` reloads the dev page. The same pass emits two more files from that README,
so neither can drift out of step with the page:

- `/llms.txt`, from the same headings the rail is built from.
- `/og.png`, the 1200×630 social card — `og/card.ts` lays it out with
  [satori](https://github.com/vercel/satori) and rasterises it with resvg, both in plain JavaScript,
  because the deploy has no browser. Its code crop is highlighted by the same shiki theme the docs
  use. Nothing is committed: change the tagline and the next deploy carries it onto every share.

Four things are written here rather than derived, and every one of them restates something the
README already says — check them when it changes:

| Where | What |
| --- | --- |
| `prerender.ts` → `PILLARS` | The three claims in the band under the hero |
| `prerender.ts` → `PANELS` | The three code samples in the hero card |
| `og/card.ts` → `SNIPPET` | The code crop on the social card |
| `og/card.ts` → `CLAIMS` | The two lines of card copy under the headline |

## Not done yet

- **No analytics.**
