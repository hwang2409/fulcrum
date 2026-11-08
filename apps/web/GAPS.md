# apps/web: library gaps

`apps/web` uses only the public exports of `@fulcrum/*`, the way an outside app would. When the app needs something
the library does not have, it is written down here. It is not worked around in the app. Each entry says what is
missing, why the app needs it, and the proposed API.

## added (small, generic, tested)

| export | why | test |
| --- | --- | --- |
| `client.onClose(listener)` in `@fulcrum/zeta` | before this, an app could not see a dropped socket until its next request failed. Reconnect needs the drop event. | `packages/zeta/test/rpc.test.ts` |
| `client.replay(session, load)` in `@fulcrum/zeta` | to rebuild a session after an open or a reconnect, history must come before the live events that arrive while it loads. Before this, those live rows rendered above the history. | `packages/zeta/test/rpc.test.ts` |
| `fromZetaHistory(rows)` in `@fulcrum/zeta` | `session_history` rows had no mapping to `RunEvent`, so an app could not show an existing session. | `packages/zeta/test/history.test.ts` |
| `discoverZeta()`, `zetaDiscoveryPath`, `ZetaDiscovery`, `ZetaClient` in `@fulcrum/zeta` | the playground fetched its discovery URL inline, and the client type had no name. | `packages/zeta/test/connect.test.ts` |
| `@fulcrum/zeta/discovery` (`zetaDiscoveryPlugin`, `createZetaDiscoveryHandler`) | the dev-server token handoff was private to the playground. It moved into the package for both apps. It now also returns the `--ws-origin` allowlist, and it answers 204 when no server runs (no file, or the file names a process that has stopped), so retries log nothing. | `packages/zeta/test/discovery.test.ts`, `apps/playground/test/zeta-discovery.integration.test.ts` |
| `themes` and `ThemeName` in `@fulcrum/react` | a theme picker needs the list. Parsing `themes.css?raw` is a bundler trick. | `packages/react/test/themes.test.ts` |
| `Composer` in `@fulcrum/react` | the app had no input. Send, steer, and stop map to zeta `send`, `steer`, and `abort` in `src/delivery.ts`, with `delivery_id`. | `packages/react/test/composer.test.tsx`, `apps/web/test/delivery.test.ts` |
| `Code` and `HighlightContext` in `@fulcrum/react` | the app colors text outside a run (the `zeta serve` command in the connection notices). Before this, only parts inside a `RunProvider` could highlight. | web gate ("the command is not highlighted") |
| core reducer: a repeated `approval_request` updates its row | a status snapshot and the live event can both carry the same approval. Before this, two rows with one id crashed `Timeline` ("outline ids must be unique"). | `packages/core/test/reducer.test.ts` |
| `session_history_fidelity` tool arguments, structured bash results, and image stubs | history now keeps bounded tool arguments, bash `exit_code`/streams, truncation markers, and image metadata. The adapter uses the same tool cards as live events. | `packages/zeta/test/history.test.ts` |
| terminal dropped-steer history | retained dropped-steer text is rebuilt as a user row with the same `not delivered` state after reload; legacy generic rows remain compact notices. | `packages/zeta/test/history.test.ts` |
| `served_turn_end` history outcome | an idle session uses the valid durable served-turn reason, including `user_stop`, and does not invent an outcome when the feature is absent. | `packages/zeta/test/served-turn-end.test.ts` |

## open gaps

- approval_reconnect: negotiated `approval_history` now distinguishes current servers from older ones. Older servers still use the documented tool-only `connection_lost` inference until they ship durable approval rows; zeta grace design remains separate (design-serve-approval-grace.md).

### 1. reconnect with backoff is app code (`@fulcrum/zeta`)
- **missing:** `connectZeta` connects once. It does not retry, it has no backoff, and it does not reconnect after a drop.
- **why:** every zeta web client needs the same state machine: connecting, connected, not running, auth failed, busy, dropped. `apps/web/src/connection.ts` implements it, with tests.
- **proposed api:** `createZetaConnection({ discover, features, backoff? }) -> { state, client, subscribe, retryNow, stop }`, where `state` is the union in `apps/web/src/connection.ts`. Move that file into `@fulcrum/zeta` after a second app needs it.

### 2. exact history-to-live handoff (zeta, then `@fulcrum/zeta`)
- **missing:** `session_history` has no cursor, and live events have no sequence number.
- **why:** `client.replay` puts the order right. But a message that commits while history loads can appear twice, and a reply that streams while the socket is down is not shown until zeta commits it. So "no duplicate or lost events" is true only for committed rows.
- **proposed api:** zeta's planned `session_events` feature (change request 04f38a7a; design `~/.zeta/scratch/design-serve-session-events.md`), then `client.replay(session, { cursor })` that dedupes by event cursor.

### 3. history tool calls have no arguments (zeta)
- **solved:** when `session_history_fidelity` is negotiated, the adapter uses bounded `tool_call.arguments` and
  `arguments_truncated`, plus retained `structured_content` and bash `exit_code`, streams, `cwd_after`, and truncation.
  Tool-result image stubs keep their metadata without inventing bytes or a size. Older servers keep the generic card and
  the bounded-text parser remains only for that legacy projection.
- **still open:** a server without `session_history_fidelity` can still return empty arguments, so that generic card is
  expected until the feature is negotiated.

### 4. list status for sessions other than the open one (zeta)
- **missing:** `list_sessions` has no run state. Only `status` reports one session, the server's own.
- **why:** the list can show `open`, `running`, or `needs approval` only for that session.
- **proposed api:** `SessionMetadata.state` (`idle` | `running` | `waiting_approval`) on `list_sessions`.

### 5. opening a session has side effects (zeta)
- **missing:** zeta has no read-only observer. To read a session, a client must `resume` it. That ends the pending approvals of the session it leaves, it can start a notification turn, and it fails with -32004 while another session runs.
- **why:** an app cannot browse past sessions while a run is in progress. The app shows "zeta is busy with another session" with a link to the running session.
- **proposed api:** the read-only observers Henry asked for ("i think read only observers would be nice"): `observe({ session_id })` and history reads that do not resume.

### 6. Timeline follow-bottom only in virtual mode (`@fulcrum/react`)
- **missing:** below 200 rows (non-virtual mode), `Timeline` does not follow the bottom and has no "jump to latest" control.
- **why:** a live run must follow the bottom at any length. The app sets `virtual` always.
- **proposed api:** follow, unseen count, and jump-to-latest in both modes, or make virtual the only mode.

### 7. no inset for the Timeline (`@fulcrum/react`)
- **missing:** the virtual Timeline measures from the top edge of its scroll box. Vertical padding or margins move the pinned bottom.
- **why:** the first row is flush with the run header.
- **proposed api:** `Timeline` `inset={{ start, end }}`, which the engine adds to its size and its end anchor.

### 8. notifications and system rows render as a bare word (`@fulcrum/react`)
- **missing:** history `system` rows (durable notification deliveries) map to `notification` items. The `Fallback` part renders them as the word "notification".
- **why:** sessions with sub-agents show many rows that say nothing.
- **proposed api:** a `Notification` part with a one-line summary and a disclosure, from the planned sub-agent row slice.

### 9. a rebuilt store loses the scroll position (`@fulcrum/react`)
- **missing:** a reconnect swaps in a new store, and `Timeline` starts a replaced store pinned to the bottom.
- **why:** a reader who scrolled up loses their place on every reconnect.
- **proposed api:** `Timeline` `anchor` / `onAnchor` (item id plus offset) that a caller can carry across a store swap.

### 10. a steer can arrive after the last provider call (zeta)
- **seen:** zeta delivers a steer at the next provider boundary of the running turn. A turn whose last answer has no
  tool call has no such boundary, so zeta drops the steer when the turn ends (`delivery_status` says `dropped`). It has
  already emitted the `user_message`, so the transcript shows a message the model never read. The zeta TUI sends a
  late steer as the next turn instead.
- **in the app:** the protocol leaves the resend to the client, so `src/delivery.ts` does what the TUI does: when a
  turn ends without a stop, each steer it dropped goes out again as a new message. The `user_message` echo carries no
  delivery id, so the client stamps the one it gets while the request is pending with the message's `intent`, and the
  resend replaces the steer's row instead of adding one (`test/delivery.test.ts`, web gate, and a live check on real zeta).
- **after a stop:** the user meant to drop the queued steers, so they are not resent. `turnEnded` still asks
  `delivery_status` for each on older servers; the app marks their rows "not delivered" (struck through, danger rail,
  and a note that the stop ended the turn first).
- **solved:** with `delivery_id` and `session_history_fidelity`, zeta emits terminal `delivery_status` rows and retains
  the steer text. Reload maps a retained dropped row to the same not-delivered user card. Legacy generic rows remain
  compact status notices.
- **proposed api:** zeta serve delivers a late steer as the next turn, as the TUI does, so every client gets it.

### 13. a stop and a dropped steer vanish after a reload (zeta)
- **solved:** a valid `served_turn_end` history row maps `user_stop` to the same neutral `stopped` run outcome used
  live. No outcome is invented when the feature is absent. Terminal dropped-steer rows are handled by #10.
- **still open:** zeta does not store a separate user-stop transcript row; the neutral run-end marker is the durable
  representation.

## library bugs found

### 11. typescript and javascript code gets almost no highlight tokens (`@fulcrum/highlight`)
- **seen:** in Chromium, a finished `ts` block in history gets one typed token (the last `;`). `sh` and `tsx` blocks get full tokens. In bun, `createHighlighter()("const a = 1;\n", "ts", { id, version: 1, state: "done" })` returns no typed tokens, and `js` and `typescript` return `variable` and `operator` but no `keyword` for `const`.
- **why it matters:** most agent output is ts or js, and Henry asked for "syntax highlighting for pretty much everything".
- **next step:** a highlight slice: a failing test for `ts`, `typescript`, `js`, and `javascript` on `const a = 1;`, then a fix to the grammar alias or scope mapping.

### 12. websocket discovery tokens are visible in request urls
- **seen:** the zeta websocket contract authenticates the loopback upgrade with `?token=`. the token is therefore visible in browser devtools and in any logging of request urls.
- **next step:** harden the generic zeta protocol with a `Sec-WebSocket-Protocol` bearer subprotocol or a one-time websocket ticket. this is intentionally not an app-local workaround.
