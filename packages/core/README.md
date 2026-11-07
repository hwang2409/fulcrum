# @fulcrum/core

`@fulcrum/core` is the harness-neutral data layer. It defines run events, reduces them into ordered outline rows and entities, and provides a batched store.

## store

`createRunStore()` owns one run. Dispatch `RunEvent` values, read `{ id, kind }` rows with `getOutline()`, and read entities with `getItem(id)`. Notifications are batched by the scheduler; synchronous reads flush pending events. Use keyed subscriptions for rows and `subscribeOutline()` for the timeline.

`getOutlineSnapshot()` returns `{ items, change }`. `change` contains splices from the previous outline. Invalid required fields are ignored and counted in diagnostics. Invalid optional fields are omitted and counted in `sanitizedFields`. Unknown events become `unknown` rows. A failed reduction enters `desynced`; reads keep the last good snapshot until `resync(events)`.

For backward history, call `beginHistory()`, publish the newest page, call `prepend(older)` for older pages, then call `endHistory()`. The store re-reduces older events with accepted live events so the result matches chronological reduction. `fromZetaEvent()` maps zeta events. `connect(transport)` adds JSON-RPC request matching. User-message `intent` and `delivery_id` values make retries and echoes join the existing row.

The zeta client retries a desync history load at 0, 0.5, 1, 2, 4, and 8 seconds. The final error is in diagnostics. `retrySession(id)` lets an app retry. `run_end.outcome` is kept in `state.endOutcome` until the next run.

## tool views

Use `defineToolMap()` to map a harness's tool arguments to generic views such as `shell`, `read`, `edit`, `write`, `search`, and `fetch`. See [other harnesses](../../docs/other-harnesses.md).
