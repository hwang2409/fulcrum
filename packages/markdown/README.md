# @fulcrum/markdown

## streaming limits

The recursive container parser fixes the three deep-streaming limits recorded in PR #13 review round 6:

- a 100 KB `blockquote > list > blockquote` stream no longer rescans retained containers;
- the unfinished nested-table prefix `>   > |` stays hidden;
- 1-byte mixed-quote deltas stay on the bounded open path used by the latency benchmark.

`test/recursive-containers.test.tsx` keeps the regressions and generated nesting up to depth 6 covered. `bun run bench:markdown` enforces the 1.2 work-ratio and 16 ms worst-delta gates.
