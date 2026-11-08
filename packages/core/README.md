# @fulcrum/core

`@fulcrum/core` is the harness-neutral data layer. It defines run events, reduces them into ordered outline rows and entities, and provides a batched store.

## store

`createRunStore()` owns one run. Dispatch generic `RunEvent` values, read ordered `{ id, kind }` entries with `getOutline()`, and read an entity with `getItem(id)`. The scheduler batches reduction and subscriber notification. Synchronous reads flush pending events. Use keyed subscriptions for entity rows and `subscribeOutline()` for the ordered timeline.

Each notification pass calls every global, outline, and keyed listener it owes, even if one throws; the first error is rethrown when the pass ends (from the scheduler job, or from the `resync`, `beginHistory`, `prepend`, or `endHistory` call that delivered it). A listener may dispatch, resync, or prepend: that work is delivered by the next pass, right after the current one, never nested in it. A synchronous scheduler such as `createRunStore((job) => job())` is safe.

`getOutlineSnapshot()` returns `{ items, change }`. A change is `{ from, splices }`, where each ordered splice is `{ index, deleteCount, items }`. Applying the splices to `from` produces `items`. Changes from one notification are merged. `change` is `null` for the first snapshot, after `resync`, and after disposal; `null` means "take `items` whole". An approval that folds into its tool row produces one splice, not a new row.

Malformed known events with an invalid required field are counted by `getDiagnostics()` and ignored. An invalid optional field is omitted, counted in `sanitizedFields`, and the sanitized event is applied. Valid events keep their identity and do not allocate a validation copy. An arbitrary event kind becomes an `unknown` row; the built-in React `Fallback` shows only its kind, not its data.

If validated reduction throws, the store calls `onError` and exposes `desynced` and its reason through `getDiagnostics()` and `subscribeDiagnostics()`. Reads keep the last good snapshot. New dispatches are refused until `resync(events)` installs history. These guarantees apply through `createRunStore`; direct reducer callers own the maps they supply and must retain the maps returned with state.

## backward history

Call `beginHistory()` before publishing the newest page and `endHistory()` when the backward walk finishes. `prepend(older)` is valid only in that window. It reduces the older page, then the accepted event log, from an empty store. The result matches chronological reduction, including generated ids and cross-event folds. Accepted live events follow older history and win naturally.

A rejected page is atomic: it publishes nothing and enters the same visible desync state as failed live reduction. Value-equal entities retain object identity. The outline update is one index-0 splice when the old outline is an exact suffix, or one full replacement when ids changed. Cost is O(older + accepted log) per prepend. Pages queued in one frame share one reduction.

## messages and lifecycle

A `user_message` can carry `intent`, the client id for the user's request. A later message with the same intent replaces that row, so a dropped and resent message appears once. `delivery_id` is its durable identity: an echo with the same id joins the existing row. `hasMessageDelivery(deliveryId)` reports whether that durable row exists.

`run_end.outcome` can be `completed`, `cancelled`, `failed`, `disconnected`, or `unknown`. `unknown` means the host could not observe the result. The store keeps it in `state.endOutcome` until the next `run_start`.

## tools

`tool_start`, `tool_input`, and `approval_request` define a call. `tool_output` and `tool_end` report its output and result; they never change a known call's name, arguments, or meta, and the row keeps the call object it has. Send `tool_start` to redefine a call. An output event for an unknown call starts its row with the event's call.

`tool_output` appends to the row's output. A protocol that resends the whole output so far (snapshots, or the AI SDK's preliminary tool output) sends `tool_output` with `replace: true`: the row keeps its position and approval decision, its output becomes the event's output, its result and error state clear, and it is live again.

## tool views

Use `defineToolMap()` to map harness tool arguments to agent-neutral views. See [using another harness](../../docs/other-harnesses.md) for schemas, examples, and approval decisions.
