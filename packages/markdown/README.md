## streaming resolver

streaming markdown uses one physical-line resolver. it owns the open document, quote, list, and item path, plus the current leaf and the document-wide reference index. it does not create child streaming documents. committed lines are processed once; only the unfinished physical line and the immediately preceding lookahead line are previewed.

`MarkdownLineResolver.classifyPending(line)` is the only pending-line classifier. the renderer uses its read-only result, so marker, fence, table, and setext decisions cannot drift between resolution and preview.

visible streaming text is monotonic. text whose final block ownership is still inherently ambiguous is emitted as `pending-text` and rendered with `data-part="md-text-pending"`; unresolved references use `pending-reference`. a complete line that can still become a table header or setext heading remains provisional until the following line settles it. fence openers commit immediately, and fence content is owned by that fence only when its container path continues.

`test/recursive-containers.test.tsx` covers generated nesting through depth 6 and the 100 kb `blockquote > list > blockquote` regression. `test/reviewer-round3.test.tsx` records the minimized fence, table, marker-cache, and non-final-text regressions. `bun run bench:markdown` takes the median of five runs and enforces the 1.2 work ratio, 2 ms p95, 4 ms p99, and 16 ms isolated-pause budgets.

`finish()` must equal the one-shot `parseMarkdown` result for every fuzz document.
