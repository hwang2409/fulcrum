## streaming resolver

streaming markdown uses one physical-line resolver. it owns the open document, quote, list, and item path, plus the current leaf and the document-wide reference index. it does not create child streaming documents. committed lines are processed once; only the unfinished physical line and the immediately preceding lookahead line are previewed.

`MarkdownLineResolver.classifyPending(line)` is the only pending-line classifier. it returns retained stable inline source, one unresolved suffix of at most 256 characters, and at most one possible owner. the renderer appends each stable node once and reparses only that suffix, so marker, fence, table, and setext decisions cannot drift between resolution and preview.

visible streaming text is monotonic. at most 256 unresolved characters can be hidden or emitted as `pending-text`; older prose is stable even when an opener such as `[` is still unresolved. a late closer can restyle the earlier retained nodes, which is an allowed style change because their characters stay in order. that closer can cost O(span) once, but later deltas return to bounded suffix work. fence openers commit immediately, and fence content is owned by that fence only when its container path continues.

`test/recursive-containers.test.tsx` covers generated nesting through depth 6 and the 100 kb `blockquote > list > blockquote` regression. `test/bounded-suffix.test.tsx` gates hidden text and copied characters. `bun run bench:markdown` takes the median of five runs and enforces the 1.2 work ratio, 2 ms p95, 4 ms p99, 50 ms isolated-pause, and delta-plus-256 copy budgets, including a 1 MB inline-rich line with an early unresolved bracket.

`finish()` must equal the one-shot `parseMarkdown` result for every fuzz document.
