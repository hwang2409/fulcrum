# @fulcrum/markdown

## streaming limits

The recursive container parser fixes the three deep-streaming limits recorded in PR #13 review round 6:

- a 100 KB `blockquote > list > blockquote` stream no longer rescans retained containers;
- the unfinished nested-table prefix `>   > |` stays hidden;
- 1-byte mixed-quote deltas stay on the bounded open path used by the latency benchmark.

`test/recursive-containers.test.tsx` keeps the regressions and generated nesting up to depth 6 covered. `bun run bench:markdown` enforces the 1.2 work-ratio and 16 ms worst-delta gates.

Two active-stream states intentionally wait for more input:

- a reference use stays pending when its definition at EOF can still receive a title on the next line;
- a pipe-led line inside a quote or list can briefly show a raw `|` until the next line decides whether it is a table. only that pipe may disappear; all other visible text must stay monotonic.

`test/fuzz.ts` permits only these exact exceptions and requires `finish()` to equal one-shot parsing.
