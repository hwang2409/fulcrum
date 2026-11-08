# @fulcrum/core

`@fulcrum/core` is the harness-neutral data layer. It defines run events, reduces them into ordered outline rows and entities, and provides a batched store.

## store

`createRunStore()` owns one run. Dispatch generic `RunEvent` values, read ordered `{ id, kind }` entries with `getOutline()`, and read an entity with `getItem(id)`. The scheduler batches reduction and subscriber notification. Synchronous reads flush pending events. Use keyed subscriptions for entity rows and `subscribeOutline()` for the ordered timeline.

Delivery, listener errors, re-entry, resync, and disposal follow the [notification contract](#notification-contract).

`getOutlineSnapshot()` returns `{ items, change }`. A change is `{ from, splices }`, where each ordered splice is `{ index, deleteCount, items }`. Applying the splices to `from` produces `items`. Changes from one notification are merged. `change` is `null` for the first snapshot, after `resync`, and after disposal; `null` means "take `items` whole". An approval that folds into its tool row produces one splice, not a new row.

Malformed known events with an invalid required field are counted by `getDiagnostics()` and ignored. An invalid optional field is omitted, counted in `sanitizedFields`, and the sanitized event is applied. Valid events keep their identity and do not allocate a validation copy. An arbitrary event kind becomes an `unknown` row; the built-in React `Fallback` shows only its kind, not its data.

If validated reduction throws, the store calls `onError` and exposes `desynced` and its reason through `getDiagnostics()` and `subscribeDiagnostics()`. Reads keep the last good snapshot. New dispatches are refused until `resync(events)` installs history. These guarantees apply through `createRunStore`; direct reducer callers own the maps they supply and must retain the maps returned with state.

## Notification contract

These rules hold for every listener kind: global (`subscribe(listener)`), outline (`subscribeOutline`), keyed (`subscribe(id, listener)`), and diagnostics (`subscribeDiagnostics`), and for the `onError` option. Each rule names the tests that enforce it; a change that breaks a rule must change its test on purpose. Test names are in `packages/core/test/store.test.ts` unless another file is named.

1. Batching: all dispatches before one scheduler job queue one job, and that job runs one pass that calls each global listener once, each outline listener once if the outline changed, and only the keyed listeners of changed ids. Tests: "100 dispatches in one burst notify subscribers exactly once", "one delta notifies only its keyed subscriber", "outline changes only when membership changes".
2. Snapshot: a pass takes and clears every pending change before its first listener runs, so every listener of the pass reads the same state. Test: "keeps one snapshot for every subscriber notification pass".
3. Delivery: a pass calls every listener it owes, even if an earlier one throws, and diagnostics listeners all run when diagnostics change, at that moment rather than per frame. Tests: "a throwing %s listener does not stop the others, and its error surfaces" (global, outline, keyed), "a throwing diagnostics listener: reads never throw, the others still run, and the scheduler job rethrows".
4. First error: the first listener or `onError` error is rethrown after delivery by the entry that delivered it: the scheduler job, `resync`, `beginHistory`, `prepend`, `endHistory`, or `resyncFailed`, and `dispatch` when a synchronous scheduler such as `createRunStore((job) => job())` runs the job inside it. Tests: "a throwing %s listener does not stop the others, and its error surfaces", "%s delivers every listener, rethrows the first error, and reports the rest", "resyncFailed delivers every diagnostics listener, then rethrows the first error", "later listener errors in a pass go to reportError, and a sync dispatch rethrows the first", "a throwing diagnostics listener under a sync scheduler: dispatch rethrows after every listener ran".
5. Later errors: every later error of the same delivery goes to the host's error sink, `reportError`, or `console.error` where `reportError` does not exist, so none vanish. A sink that throws (a fail-on-console test setup, a mocked `reportError`) cannot cut delivery short, replace the first error, or leave it for a later entry: its own throw is dropped, since there is nowhere left to report it. Tests: "later listener errors in a pass go to reportError, and a sync dispatch rethrows the first", "later listener errors go to console.error where reportError does not exist", "a throwing $sink: every listener runs, the job rethrows the first error, and reads never throw" (one row per sink).
6. Reads: `getState`, `getItem`, `getOutline`, `getOutlineSnapshot`, `hasMessageDelivery`, and `getDiagnostics` never throw a listener or `onError` error; an error raised while a read flushes is rethrown by the scheduler job that the dispatch queued. Tests: "read methods never throw a listener error, inside or after a failing pass", "a throwing diagnostics listener: reads never throw, the others still run, and the scheduler job rethrows", "a throwing onError never escapes a read: the store still desyncs, and the scheduler job rethrows it", "a throwing onError on a rejected prepend page never escapes a read: the store desyncs, and the scheduler job rethrows it", "a throwing $sink: every listener runs, the job rethrows the first error, and reads never throw".
7. Re-entry: a resync, a history page, or a dispatch whose scheduler job ran during a pass, started by a listener, is delivered by the next pass right after the current one, never nested in it, and any other dispatch from a listener waits for its own scheduler job. Tests: "resync from a listener is delivered after the running notification, not nested in it", "resync from a $from listener ($start, to $replay): every consumer ends on the replayed state", "queues subscriber dispatches until after the current notification", `packages/react/test/resync.test.tsx` "resync called from a %s listener reaches every consumer".
8. Termination: a synchronous scheduler never makes the store spin, from any entry or from a listener's dispatch, history page, or `endHistory`. Test: "$entry with a synchronous scheduler: a listener's dispatch is delivered after the pass" (each row runs in a child process with a 3 s limit, so a spin fails the row instead of hanging).
9. Recovery: a throw that escapes a pass (such as a stack overflow) or the host's scheduler leaves no flag set, so later notifications and dispatches still work, and the scheduler's throw reaches the caller. After a scheduler throw the event stays queued and the next dispatch's job or a read delivers it; do not dispatch it again. A throw that escapes a pass after an earlier listener error of that pass leaves the earlier error for the next entry to rethrow. Tests: "an overflow escaping a pass does not silence later notifications", "a throwing scheduler does not stop later dispatches from scheduling".
10. Resync: `resync` publishes `change: null` ("take `items` whole"), calls outline listeners only when a change was pending or the rows differ, and calls the keyed listener of every prior and every new row; search, the Timeline live region, keyed item subscriptions, and both Timelines end on the replayed rows. Tests: "resync tells subscribers to take the outline whole: $name" (one row per case), "two resyncs before a frame: each notifies only when its rows differ, and the last replay wins", `packages/react/test/resync.test.tsx` "resync reaches every outline consumer whole: $name" (one column per consumer).
11. Disposal: `dispose` drops pending events and history pages, publishes `{ items: [], change: null }`, and calls no listener after it, including the rest of a pass when a listener calls `dispose`; a listener error that no running entry will rethrow (a read flushed it) goes to the error sink, so nothing rethrows after `dispose`; `dispatch`, `resync`, `beginHistory`, and `prepend` then throw "store is disposed", `endHistory` and `dispose` do nothing, and a reduction that disposes the store publishes nothing. Tests: "dispose publishes an empty outline, notifies no one after, and every later entry throws or does nothing", "dispose from a listener stops the rest of the pass: global, outline, keyed", "dispose from a diagnostics listener stops the rest of the pass: diagnostics", "dispose hands an undelivered listener error to reportError, and no job rethrows it after dispose", "dispose stops notifications, drops pending chunks, and rejects dispatch", "does not publish a reduction when disposed during the reduction".

Every host callback the store invokes, and where it stands:

| callback | status |
|---|---|
| global, outline, and keyed listeners | covered by the delivery owner |
| diagnostics listeners | covered by the delivery owner |
| `options.onError` | covered by the delivery owner |
| host error sink (`reportError`, or `console.error` where it does not exist) | guarded: a throwing sink cannot cut delivery; its own throw is dropped, since there is nowhere left to report it (rule 5) |
| `scheduler(job)` | outside: it schedules work, it does not deliver it; its throw reaches the caller of `dispatch` or `prepend` and leaves no flag set; the event stays queued and the next dispatch's job or a read delivers it; do not dispatch it again (rule 9) |
| getters or proxies on a dispatched event | outside: a throw while reducing is a reduction failure, handled by desync and `onError`, not a listener error |
| unsubscribe functions | call no host code |
| `dispose` | calls no listener; only the guarded error sink, for an error no entry will rethrow (rule 11) |

A new listener kind goes through the delivery owner and gets a row here and a test.

## backward history

Call `beginHistory()` before publishing the newest page and `endHistory()` when the backward walk finishes. `prepend(older)` is valid only in that window. It reduces the older page, then the accepted event log, from an empty store. The result matches chronological reduction, including generated ids and cross-event folds. Accepted live events follow older history and win naturally.

A rejected page is atomic: it publishes nothing and enters the same visible desync state as failed live reduction. Value-equal entities retain object identity. The outline update is one index-0 splice when the old outline is an exact suffix, or one full replacement when ids changed. Cost is O(older + accepted log) per prepend. Pages queued in one frame share one reduction.

## messages and lifecycle

A `user_message` can carry `intent`, the client id for the user's request. A later message with the same intent replaces that row, so a dropped and resent message appears once. `delivery_id` is its durable identity: an echo with the same id joins the existing row. `hasMessageDelivery(deliveryId)` reports whether that durable row exists.

`run_end.outcome` can be `completed`, `cancelled`, `failed`, `disconnected`, or `unknown`. `unknown` means the host could not observe the result. The store keeps it in `state.endOutcome` until the next `run_start`.

## tools

`tool_start`, `tool_input`, and `approval_request` define a call. `tool_output` and `tool_end` report its output and result; they never change a known call's name, arguments, or meta, and the row keeps the call object it has. Send `tool_start` to redefine a call. An output event for an unknown call starts its row with the event's call.

`tool_output` appends to the row's output. A protocol that resends the whole output so far (snapshots, or the AI SDK's preliminary tool output) sends `tool_output` with `replace: true`: the row keeps its position and approval decision, its output becomes the event's output, its result and error state clear, and it is live again.

`tool_start` on a known call restarts its row in place: output, result, and error clear, the view becomes the event's `view`, an approval decision stays, the row keeps its position.

## tool views

Use `defineToolMap()` to map harness tool arguments to agent-neutral views. See [using another harness](../../docs/other-harnesses.md) for schemas, examples, and approval decisions.
