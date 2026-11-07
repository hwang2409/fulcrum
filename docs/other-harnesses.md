# use fulcrum with another harness

Fulcrum cards are generic. Map a harness's events to `@fulcrum/core` events and map tool arguments to agent-neutral views with `defineToolMap`.

Built-in views are `shell`, `read`, `edit`, `write`, `search`, and `fetch`. A tool without a view uses the generic card, so data is not lost. Resolvers return no view for missing or invalid arguments instead of throwing. `lineDiff(before, after)` creates an edit diff.

`@fulcrum/zeta` exports `zetaTools` and attaches views for zeta tools. A second harness can define its own map. Use `packages/core/test/tool-map.test.ts` as a reference.
