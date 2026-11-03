## streaming resolver

streaming markdown uses one physical-line resolver. it owns the open document, quote, list, and item path, plus the current leaf and the document-wide reference index. it does not create child streaming documents. committed lines are processed once; only the unfinished physical line is previewed.

`test/recursive-containers.test.tsx` covers generated nesting through depth 6 and the 100 kb `blockquote > list > blockquote` regression. `bun run bench:markdown` enforces the 1.2 work-ratio and 16 ms worst-delta gates.

three active-stream transitions are measured exceptions:

- an eof reference definition stays pending while a next-line title is still possible;
- a pipe-led nested line can remain undecided until the delimiter line establishes or rejects a table;
- a complete retroactive block marker can remove its own syntax from visible text. the minimized case is `1. 3. setext heading\n      ===`: the completed `===` becomes heading syntax. this is recorded as `block-marker-transition`, not a parse failure.

all exceptions remain crash-free. `finish()` must equal the one-shot `parseMarkdown` result for every fuzz document.
