import { expect, test } from "bun:test";
import type { RunEvent } from "@fulcrum/core";
import { relabel, replayStep } from "../src/replay";

const event = (type: RunEvent["type"]): RunEvent =>
  type === "approval_request"
    ? { type, request_id: "r1", tool_call: { id: "t1", name: "tool", arguments: {} }, delegated: false }
    : { type: "message_commit", message_id: "m1", message: { role: "assistant", content: [] } };

test("pauses at an approval and does not count paused time", () => {
  const events = [
    event("message_commit"),
    event("approval_request"),
    event("message_commit"),
    event("message_commit"),
    event("message_commit"),
    event("message_commit"),
    event("message_commit"),
    event("message_commit"),
    event("message_commit"),
    event("message_commit"),
  ];
  let index = 0;
  const first = replayStep(() => events[index++], { budget: 5, paused: false, elapsed: 0, rate: 200 });

  expect(first.events).toHaveLength(2);
  expect(first.paused).toBe(true);

  const paused = replayStep(() => events[index++], { ...first, elapsed: 10_000, rate: 200 });
  const resumed = replayStep(() => events[index++], { ...paused, budget: 0, paused: false, elapsed: 16, rate: 200 });

  expect(paused.budget).toBe(first.budget);
  expect(resumed.events).toHaveLength(3);
});

test("relabels every id on a later lap so a looped fixture adds new items", () => {
  const request = event("approval_request");
  const commit = event("message_commit");
  expect(relabel(request, 0)).toBe(request);
  expect(relabel(request, 2)).toMatchObject({ request_id: "r1~2", tool_call: { id: "t1~2" } });
  expect(relabel(commit, 1)).toMatchObject({ message_id: "m1~1" });
  expect(relabel({ type: "tool_end", tool_call: { id: "t1", name: "x", arguments: {} }, tool_result: { tool_call_id: "t1", content: "", is_error: false } }, 1)).toMatchObject({ tool_result: { tool_call_id: "t1~1" } });
});
