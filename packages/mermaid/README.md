# @fulcrum/mermaid

mermaid diagrams for `@fulcrum/markdown`. a ```` ```mermaid ```` fence streams in as highlighted source, exactly as any code block; once its closing fence arrives, and it is near the viewport, it draws once at idle time and switches to the diagram in one step. the published package has no runtime dependencies: mermaid and dompurify are bundled into a lazy module that a page loads on its first diagram, never before.

```tsx
import { Markdown, type Fences } from "@fulcrum/markdown/react";
import { MermaidFence } from "@fulcrum/mermaid";
import "@fulcrum/mermaid/styles.css"; // after @fulcrum/react/styles.css

const fences: Fences = { mermaid: MermaidFence }; // module scope: a stable object
<Markdown source={text} streaming={streaming} highlight={highlight} fences={fences} />
```

`fences` maps a lowercase fence language to a component that gets `FenceProps` (`id`, `code`, `language`, `done`, and `source`, the highlighted code block markdown would draw). any other diagram or math renderer plugs in the same way.

## what it does

- **streaming**: while the fence is open, and until its diagram is ready, the box is the highlighted source, unchanged (colored when `@fulcrum/highlight` has a `mermaid` grammar). the diagram draws only after the fence closes, and never again for later tokens of the message.
- **one swap**: the svg goes in before paint in the commit that hides the source, so the box goes from the source's height to the diagram's in one layout, with no blank frame. the timeline's own anchoring keeps the reading position (`apps/playground/scripts/mermaid-check.ts` checks 1 px in virtual and plain timelines).
- **controls**: diagram or source (a pressed toggle), copy source, and open full size (a modal `<dialog>`: Escape closes it and focus returns to `open`). the svg is `role="img"` with a label from the diagram: its `accTitle`, else its type and label texts.
- **errors**: an invalid diagram keeps its source, with mermaid's parse error shortened under it. the rest of the message is unaffected.
- **size**: the diagram block is `data-wide`, so it takes the message's whole content width, not the 80ch text measure (see the root README). a diagram is scaled down to fit that box while its smallest label stays 11 px or more, and never scaled up. wider than that, it keeps that readable scale and scrolls inside its box (never the page): the box becomes a labelled, focusable scroll region, with an edge fade on each side that has more to see. the scale follows the box when it resizes. "open" always shows the natural size. a crowded gantt axis keeps every nth date, so no two dates overlap.
- **theme**: the diagram uses the `--fulcrum-*` tokens at the fence (bg, fg, muted, surface, border, accent, ok, warn, danger, and the syntax colors for series) through mermaid's `base` theme, the element's font (JetBrains Mono in fulcrum), no corner radius, gradient, or shadow. a `data-fulcrum-theme` change anywhere in the page, a `class` or `style` change on `<html>` or `<body>`, or an OS color scheme change, draws visible diagrams again in the new colors; the old diagram stays up until the new one is in.
- **speed**: rendering waits for idle time (`requestIdleCallback`, 500 ms timeout) and for the box to come within 800 px of the view (an `IntersectionObserver`, which also watches the scroller that clips it). renders run one at a time, and each source and theme renders once: a cache of 128 diagrams serves remounts (virtual rows scrolling back) and theme switches back, in the commit that mounts them.

## security

- mermaid runs with `securityLevel: "strict"` and `htmlLabels: false`. the diagram's own `%%{init}%%` directives and frontmatter cannot change the security level, html labels, theme, font, or limits (mermaid's `secure` keys).
- the svg is sanitized again with dompurify into DOM nodes (`RETURN_DOM_FRAGMENT`), which are adopted into the page: no untrusted string is ever set as html. it drops scripts, event handlers, `foreignObject` (html), links, `image`, animation elements, `href`s that are not `#fragment` references, and any attribute or `<style>` with a `url()` that leaves the svg or an `@import`. click callbacks never bind: fulcrum never calls mermaid's `bindFunctions`.
- each mounted copy gets its own ids, so two copies of one diagram never share markers or style rules.

### csp

- `style-src 'unsafe-inline'` (or equivalent): the svg carries a `<style>` element and `style` attributes that mermaid generates, and mermaid writes inline styles into the measuring element it adds to `<body>` while drawing.
- no `script-src` change: no `eval`, `new Function`, blob urls, or wasm. `dist/render.js` and its chunks load as ordinary module scripts from the package's origin.
- `font-src` as your page already needs: diagrams use the page's font.
- the svg loads nothing: no `img-src` or `connect-src` change.

## bundlers

`dist/index.js` (the fence, a few kB) loads `./render.js` with a dynamic `import()`. vite, rollup, webpack, and esbuild with splitting emit it and its chunks as lazy files; mermaid's diagram types are their own chunks, so a page fetches the code for the types it draws. `bun run check:mermaid-bundle` checks that the playground's page entries have no mermaid code in their static imports.
