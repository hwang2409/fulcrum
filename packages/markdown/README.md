# @fulcrum/markdown

`@fulcrum/markdown` is a framework-free, dependency-free streaming CommonMark and GFM document core. `@fulcrum/markdown/react` is the optional React renderer and uses `@fulcrum/react` as a peer for code blocks and large viewers.

## usage

```tsx
import { Markdown } from "@fulcrum/markdown/react";
import { Message } from "@fulcrum/react";

<Message id={id} markdown={Markdown} />;
```

The streaming document freezes completed blocks, table rows, and list items. Open fences and plain paragraphs consume only appended text. `Markdown` covers CommonMark and GFM message content: ATX/setext headings, paragraphs, inline/indented/fenced code, nested/task lists, emphasis, reference and literal links, images, blockquotes, tables, rules, entities, and hard breaks. Raw HTML stays escaped.

Every URL uses `safeUrl` from `@fulcrum/core`. Links allow HTTP, HTTPS, `mailto:`, and relative URLs. Images also allow inline PNG, JPEG, GIF, WebP, AVIF, or BMP `data:` URLs. A URL above `MAX_URL_CHARS` (8 MiB) is rejected before other work. Addresses never become labels, titles, or data attributes.

Code blocks accept the `Highlight` returned by `createHighlighter()` from `@fulcrum/highlight`. The shared callback receives `(code, language, { id, version, state })` and returns tokens immediately or in a promise. `state` is `streaming` or `done`; stale async results are ignored. Tokens without a `type` render as plain text; styled token classes are `tok-keyword`, `tok-string`, `tok-number`, `tok-comment`, `tok-function`, `tok-type`, `tok-variable`, `tok-constant`, `tok-operator`, `tok-punctuation`, `tok-tag`, `tok-attribute`, `tok-regexp`, `tok-inserted`, and `tok-deleted`. Copy `@fulcrum/react/styles.css` and `@fulcrum/react/themes.css`; also copy `@fulcrum/highlight/styles.css` when code highlighting is enabled. Regenerate the vendored parser with `bun run vendor:markdown-it`.

A fenced block over 40 lines, or with more tokens than one commit should draw, is the same bounded virtual viewer the tool cards use, at the height of 40 lines: it colors its visible 500-character ranges first; once they have colored, a block of at most 10,000 characters is also colored whole in the background, so a comment or string that crosses a range edge settles to the right colors. A larger block keeps each range's own colors, so a construct longer than a range (a long block comment or docstring) can show the wrong colors after a range edge. A streaming fence follows its newest line. Only the visible window is mounted, so browser find-in-page reaches only the visible lines; the copy control copies the whole block.

The headless renderer has no visual styles. Its stable styling hooks are `data-part="md-paragraph"`, `md-heading`, `md-code-inline`, `md-code-block`, `md-list`, `md-list-item`, `md-emphasis`, `md-strong`, `md-strike`, `md-link`, `md-image`, `md-blockquote`, `md-table`, `md-rule`, and `md-break`. Code blocks also expose `data-language`, and `data-state="streaming"` while their fence is still open (`"done"` once it closes). Headings use `headingOffset={2}` by default, so markdown `#` through `######` render as h3 through h6 for message content. Set `headingOffset={0}` when markdown is the page's main content. Each heading keeps its source level in `data-level`, which lets styles preserve the source-level appearance when the semantic tag is clamped.

## implementation notes

## streaming resolver

streaming markdown uses one physical-line resolver. it owns the open document, quote, list, and item path, plus the current leaf and the document-wide reference index. it does not create child streaming documents. committed lines are processed once; only the unfinished physical line and the immediately preceding lookahead line are previewed.

`MarkdownLineResolver.classifyPending(line)` is the only pending-line classifier. it returns the block kind and the offset where the leaf's inline content starts. `PendingInline` (`src/pending-inline.ts`) owns that inline content: stable nodes for `content.slice(0, emittedEnd)`, an opener stack, and a suffix of at most 128 characters (plus up to 64 characters of slack, so a cut lands after a space) that is parsed again on each delta. `emittedEnd` only grows, so stable text is emitted once. the newline that commits the line reuses the stable nodes and parses only the text after the first unresolved opener.

visible streaming text is monotonic: a character the reader has seen never disappears, and a raw marker may later become a style. openers are classified with the shared CommonMark flanking rules in `src/delimiters.ts`, so `snake_case` and `2 * 3` never open anything. an unresolved opener's marker is hidden, and the text after it stays visible as it streams. when a closer leaves the suffix, only the span after the opener it resolves is parsed again, once, so one closer costs O(span) and k closers cost O(k * suffix + total span). a style that arrives late persists. link destinations, reference labels, and setext underlines are syntax that the final output never shows, so they stay hidden. fence openers commit immediately, and fence content is owned by that fence only when its container path continues.

`test/recursive-containers.test.tsx` covers generated nesting through depth 6 and the 100 kb `blockquote > list > blockquote` regression. `test/pending-inline.test.tsx` and `test/bounded-suffix.test.tsx` gate duplication, lost text, closers around the suffix budget, late styles, intraword markers, and copied characters. `bun run bench:markdown` takes the median of five runs and enforces the 1.2 work ratio, 2 ms p95, 4 ms p99, 50 ms isolated-pause, and delta-plus-suffix copy budgets, plus five 1 MB inline-rich lines (p99 <= 5 ms, p999 <= 50 ms) with and without an early unresolved bracket.

`finish()` must equal the one-shot `parseMarkdown` result for every fuzz document.

## fence renderers

`<Markdown fences={{ mermaid: MermaidFence }} />` draws a fenced block with the component registered for its language (matched in lowercase); every other fence is the highlighted code block, unchanged. the component gets `FenceProps`: `id`, `code`, `language`, `done` (false while the fence streams), and `source`, the code block markdown would draw, to show while it is not ready or as a source view. a closed fence renders its component once, not again for later tokens of the message. pass a stable `fences` object (module scope), as with `highlight`. `@fulcrum/mermaid` is the first renderer; math or other diagram renderers plug in the same way.
