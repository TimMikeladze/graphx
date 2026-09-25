/**
 * The one inline stylesheet, shared by both pages. Greyscale chrome, one accent, colour only where it
 * carries syntax or state. System fonts, no shadows, no gradients: depth is the paper/band/raise ladder.
 */

const darkTokens = `
  color-scheme: dark;
  --paper: oklch(12.5% 0 0);
  --band: oklch(15.5% 0 0);
  --raise: oklch(18.5% 0 0);
  --ink: oklch(98.5% 0 0);
  --body: oklch(78% 0 0);
  --soft: oklch(60% 0 0);
  --line: oklch(100% 0 0 / .11);
  --line-soft: oklch(100% 0 0 / .06);
  --accent: oklch(70% 0.16 250);
  --add: oklch(72% 0.17 150);
  --del: oklch(68% 0.19 20);
  --warn: oklch(78% 0.15 85);`;

const lightTokens = `
  color-scheme: light;
  --paper: oklch(99% 0 0);
  --band: oklch(97% 0 0);
  --raise: oklch(100% 0 0);
  --ink: oklch(14.5% 0 0);
  --body: oklch(38% 0 0);
  --soft: oklch(48% 0 0);
  --line: oklch(0% 0 0 / .12);
  --line-soft: oklch(0% 0 0 / .06);
  --accent: oklch(52% 0.18 250);
  --add: oklch(50% 0.16 150);
  --del: oklch(50% 0.19 25);
  --warn: oklch(55% 0.13 80);`;

export const css = `
:root {${darkTokens}
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
:root[data-theme="light"] {${lightTokens}
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]):not([data-theme="light"]) {${lightTokens}
  }
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; background: var(--paper); color: var(--body); font: 1rem/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4 { color: var(--ink); margin: 0; }
p { margin: 0; }
a { color: inherit; }
img, svg { display: block; max-width: 100%; }
button { font: inherit; color: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.shell { width: min(1180px, calc(100% - 3rem)); margin-inline: auto; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip { position: absolute; left: 1rem; top: -4rem; z-index: 20; padding: .5rem .8rem; background: var(--ink); color: var(--paper); border-radius: .4rem; text-decoration: none; }
.skip:focus { top: .75rem; }

/* inline code + prose links */
code { font-family: var(--mono); }
.prose code, .lede code, .aside code, .credit code, td code, li code, .reference p code { font-size: .9em; color: var(--ink); background: var(--raise); padding: .1em .32em; border-radius: .28rem; }
.prose a, .lede a, .aside a, .credit a, .reference a:not(.anchor) { color: var(--ink); text-decoration: underline; text-underline-offset: .18em; text-decoration-color: var(--line); transition: text-decoration-color .14s ease; }
.prose a:hover, .lede a:hover, .aside a:hover, .credit a:hover, .reference a:not(.anchor):hover { text-decoration-color: var(--accent); }

/* header */
.header { position: sticky; top: 0; z-index: 10; min-height: 3.75rem; display: flex; align-items: center; background: color-mix(in oklab, var(--paper) 82%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.header .shell { display: flex; align-items: center; gap: 1.4rem; }
.brand { font-weight: 700; font-size: 1.05rem; color: var(--ink); text-decoration: none; letter-spacing: -.01em; }
.nav { display: flex; align-items: center; gap: 1.25rem; }
.nav a { font-size: .875rem; color: var(--soft); text-decoration: none; transition: color .14s ease; }
.nav a:hover, .nav a[aria-current="page"] { color: var(--ink); }
.ext::after { content: " ↗"; font-size: .75em; opacity: .5; }
.nav-more { display: none; }
.icons { margin-left: auto; display: flex; align-items: center; gap: .75rem; }
.icons a, .theme { display: inline-flex; align-items: center; justify-content: center; color: var(--soft); background: none; border: 0; padding: 0; transition: color .14s ease; }
.icons a:hover, .theme:hover { color: var(--ink); }
.theme { width: 18px; height: 18px; margin-left: .25rem; }
.theme svg { display: none; }
.theme .i-system { display: block; }
:root[data-mode="dark"] .theme svg, :root[data-mode="light"] .theme svg { display: none; }
:root[data-mode="dark"] .theme .i-dark, :root[data-mode="light"] .theme .i-light { display: block; }

/* hero */
.hero { padding-block: clamp(3.5rem, 8vw, 6.5rem) clamp(2rem, 4vw, 3rem); }
.mark { display: inline-grid; place-items: center; width: var(--mark); height: var(--mark); border-radius: 22%; background: var(--raise); border: 1px solid var(--line); color: var(--ink); margin-bottom: 1.6rem; }
h1 { font: 700 clamp(2.6rem, 6vw, 4.2rem)/1.03 var(--sans); letter-spacing: -.04em; max-width: 16ch; }
.lede { font-size: clamp(1.05rem, 1.6vw, 1.2rem); line-height: 1.55; max-width: 58ch; margin-top: 1.3rem; }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.9rem; align-items: center; }
.control { display: inline-flex; align-items: center; gap: .5rem; padding: .62rem .85rem; border-radius: .6rem; border: 1px solid var(--line); background: var(--raise); color: var(--ink); font: 500 .9rem/1.15 var(--sans); text-decoration: none; transition: background .14s ease, border-color .14s ease; }
.control:hover { border-color: var(--line); background: color-mix(in oklab, var(--raise) 80%, var(--ink) 4%); }
.control code { font: .88rem/1 var(--mono); background: none; padding: 0; color: inherit; }
.control--solid { background: var(--ink); color: var(--paper); border-color: transparent; font-weight: 550; }
.control--solid:hover { background: color-mix(in oklab, var(--ink) 88%, var(--paper)); border-color: transparent; }
.install { flex: 1 1 15rem; max-width: 22rem; justify-content: space-between; }
.install .glyph { color: var(--soft); }
details.agents { position: relative; }
details.agents > summary { list-style: none; }
details.agents > summary::-webkit-details-marker { display: none; }
.agents-menu { position: absolute; top: calc(100% + .4rem); left: 0; z-index: 5; min-width: 15rem; display: grid; padding: .35rem; background: var(--raise); border: 1px solid var(--line); border-radius: .6rem; }
.agents-menu a, .agents-menu button { display: flex; align-items: center; gap: .5rem; padding: .5rem .6rem; border-radius: .4rem; border: 0; background: none; color: var(--body); font: .875rem/1.2 var(--sans); text-decoration: none; text-align: left; transition: background .14s ease, color .14s ease; }
.agents-menu a:hover, .agents-menu button:hover { background: var(--band); color: var(--ink); }
.version { margin-top: 1.1rem; font-size: .85rem; color: var(--soft); }

/* sections */
.section { padding-block: clamp(3.5rem, 7vw, 6rem); scroll-margin-top: 4.5rem; }
.section:nth-of-type(even) { background: var(--band); }
h2 { font: 650 clamp(1.35rem, 2.4vw, 1.7rem)/1.2 var(--sans); letter-spacing: -.02em; }
.section .prose { max-width: 68ch; margin-top: .6rem; }
.section .demo, .section .variants, .section .table-wrap { margin-top: 1.6rem; }
.aside { max-width: 68ch; margin-top: 2rem; color: var(--soft); }

/* demo frame */
.demo { border: 1px solid var(--line); border-radius: .7rem; overflow: hidden; background: var(--paper); min-width: 0; }
.bar { display: flex; align-items: center; gap: .6rem; padding: .6rem .9rem; background: var(--band); border-bottom: 1px solid var(--line); font: .8rem/1.2 var(--mono); color: var(--soft); min-height: 2.5rem; }
.section:nth-of-type(even) .demo { background: var(--paper); }
.dots { display: inline-flex; gap: .4rem; }
.dots i { width: 10px; height: 10px; border-radius: 50%; background: var(--line); display: block; }
.bar .cmd { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { margin-left: auto; font: .7rem/1 var(--mono); padding: .25rem .5rem; border: 1px solid var(--line); border-radius: 999px; color: var(--soft); white-space: nowrap; }
.demo pre { margin: 0; padding: 1rem 1.1rem; overflow-x: auto; font: .8rem/1.6 var(--mono); background: var(--paper); color: var(--body); tab-size: 2; }
.demo pre code { font: inherit; background: none; padding: 0; color: inherit; }
.shiki, .shiki span { background: transparent !important; }
.shiki span { color: var(--shiki-dark); }
:root[data-theme="light"] .shiki span { color: var(--shiki-light); }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]):not([data-theme="light"]) .shiki span { color: var(--shiki-light); } }

.variants { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.1rem; }
.variant { min-width: 0; }
.variant .demo { height: calc(100% - 1.8rem); margin-top: 0; }
.section .start-grid .demo { margin-top: 0; }
figure { margin: 0; }
.caption { margin-top: .6rem; font: .75rem/1.4 var(--mono); color: var(--soft); }

/* table */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th { text-align: left; font: .72rem/1.2 var(--mono); text-transform: uppercase; letter-spacing: .08em; color: var(--soft); padding: .6rem .8rem .6rem 0; border-bottom: 1px solid var(--line-soft); font-weight: 400; }
td { padding: .65rem .8rem .65rem 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
td:first-child { font-family: var(--mono); white-space: nowrap; }
td:first-child code { font-size: .9em; }

/* boundaries */
.cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2rem; margin-top: 1.6rem; }
.cols h3 { font: 600 1rem/1.3 var(--sans); display: flex; gap: .5rem; align-items: baseline; }
.count { font: .75rem/1 var(--mono); color: var(--soft); }
.cols ul { list-style: none; padding: 0; margin: .9rem 0 0; display: grid; gap: .8rem; }
.cols li { padding-top: .8rem; border-top: 1px solid var(--line-soft); font-size: .95rem; }
.cols .holds h3::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: var(--add); align-self: center; }
.cols .judgements h3::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: var(--warn); align-self: center; }
.cols .missing h3::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: var(--del); align-self: center; }
.start-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.1rem; margin-top: 1.6rem; }
.start-grid .demo { margin: 0; }

/* footer */
.footer { border-top: 1px solid var(--line); padding-block: clamp(2.5rem, 5vw, 4rem) 2rem; margin-top: 0; }
.credit { max-width: 60ch; color: var(--soft); font-size: .95rem; }
.fcols { display: flex; flex-wrap: wrap; gap: 2rem 4rem; margin-top: 2rem; }
.fcols h2 { font: 600 .85rem/1.2 var(--sans); letter-spacing: 0; margin-bottom: .7rem; }
.fcols ul { list-style: none; padding: 0; margin: 0; display: grid; gap: .45rem; }
.fcols a { font-size: .85rem; color: var(--soft); text-decoration: none; transition: color .14s ease; }
.fcols a:hover { color: var(--ink); }
.ficons { display: flex; gap: .9rem; margin-top: 1.6rem; }
.ficons a { color: var(--soft); transition: color .14s ease; display: inline-flex; }
.ficons a:hover { color: var(--ink); }
.copy { margin-top: 1.6rem; font-size: .8rem; color: var(--soft); }

/* reference page */
.ref { display: grid; grid-template-columns: 15rem minmax(0, 1fr); gap: 3rem; padding-block: 3rem 5rem; align-items: start; }
.toc { position: sticky; top: 5.5rem; max-height: calc(100vh - 7rem); overflow-y: auto; }
.toc p { font: .72rem/1.2 var(--mono); text-transform: uppercase; letter-spacing: .08em; color: var(--soft); margin-bottom: .8rem; }
.toc ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .35rem; }
.toc a { font-size: .85rem; color: var(--soft); text-decoration: none; transition: color .14s ease; }
.toc a:hover { color: var(--ink); }
.reference { min-width: 0; max-width: 78ch; }
.reference h1 { font-size: clamp(2rem, 4vw, 2.6rem); max-width: none; margin-bottom: 1rem; }
.reference h2 { margin-top: 3.2rem; padding-top: 1.4rem; border-top: 1px solid var(--line-soft); scroll-margin-top: 4.5rem; }
.reference h3 { font: 600 1.1rem/1.3 var(--sans); margin-top: 2rem; scroll-margin-top: 4.5rem; }
.reference p, .reference ul, .reference ol { margin-top: .9rem; }
.reference li + li { margin-top: .3rem; }
.reference code { font-size: .9em; color: var(--ink); background: var(--raise); padding: .1em .32em; border-radius: .28rem; }
.reference pre { tab-size: 2; margin: 1.1rem 0 0; border: 1px solid var(--line); border-radius: .7rem; overflow-x: auto; padding: 1rem 1.1rem; background: var(--paper); font: .8rem/1.6 var(--mono); }
.reference pre code { background: none; padding: 0; font: inherit; color: inherit; }
.reference .table-wrap { margin-top: 1.1rem; }
.anchor { color: var(--soft); text-decoration: none; margin-right: .4rem; opacity: 0; transition: opacity .14s ease; }
h2:hover .anchor, h3:hover .anchor, .anchor:focus-visible { opacity: 1; }

@media (max-width: 900px) {
  .variants, .cols, .start-grid { grid-template-columns: minmax(0, 1fr); }
  .ref { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; }
  .toc { position: static; max-height: none; }
}
@media (max-width: 720px) {
  .shell { width: calc(100% - 2rem); }
  .nav { display: none; }
  .nav-more { display: block; position: relative; }
  .nav-more > summary { list-style: none; font-size: .875rem; color: var(--soft); cursor: pointer; }
  .nav-more > summary::-webkit-details-marker { display: none; }
  .nav-more .menu { position: absolute; top: calc(100% + .8rem); left: -1rem; display: grid; gap: .2rem; min-width: 11rem; padding: .5rem; background: var(--raise); border: 1px solid var(--line); border-radius: .6rem; }
  .nav-more .menu a { padding: .45rem .6rem; font-size: .875rem; color: var(--body); text-decoration: none; }
  .header .shell { gap: .9rem; }
  .icons { gap: .6rem; }
  h1 { font-size: 2.6rem; }
  .install { max-width: none; flex-basis: 100%; }
  .install code { overflow-wrap: anywhere; }
  .demo { margin-inline: -1rem; border-radius: 0; border-inline: 0; }
  .variant .demo { height: auto; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; scroll-behavior: auto !important; transform: none !important; }
}
`;

/** Runs before the stylesheet: resolve the stored preference and set data-theme with no flash. */
export const bootScript = `(function () {
  var KEY = "graphx-theme";
  var root = document.documentElement;
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  function stored() {
    try { var v = localStorage.getItem(KEY); return v === "dark" || v === "light" ? v : "system"; } catch (e) { return "system"; }
  }
  function apply() {
    var mode = stored();
    root.setAttribute("data-mode", mode);
    root.setAttribute("data-theme", mode === "system" ? (mq.matches ? "dark" : "light") : mode);
  }
  apply();
  mq.addEventListener("change", function () { if (stored() === "system") apply(); });
  window.__graphxTheme = { key: KEY, apply: apply, stored: stored };
})();`;

/** The second script: theme toggle, copy install, copy page as Markdown. */
export const uiScript = `(function () {
  var t = window.__graphxTheme;
  var order = ["system", "dark", "light"];
  function flash(el, text) { var n = el.querySelector("[data-say]"); if (!n) return; var was = n.textContent; n.textContent = text; setTimeout(function () { n.textContent = was; }, 1400); }
  var toggle = document.querySelector(".theme");
  if (toggle && t) {
    function label() { toggle.setAttribute("aria-label", "Theme: " + t.stored() + ". Click to change"); }
    label();
    toggle.addEventListener("click", function () {
      var next = order[(order.indexOf(t.stored()) + 1) % order.length];
      try { if (next === "system") localStorage.removeItem(t.key); else localStorage.setItem(t.key, next); } catch (e) {}
      t.apply(); label();
    });
  }
  function copy(text, el) { if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { flash(el, "Copied"); }); }
  var install = document.querySelector("[data-copy]");
  if (install) install.addEventListener("click", function () { copy(install.getAttribute("data-copy"), install); });
  var page = document.querySelector("[data-copy-md]");
  if (page) page.addEventListener("click", function () { fetch(page.getAttribute("data-copy-md")).then(function (r) { return r.text(); }).then(function (md) { copy(md, page); }); });
})();`;
