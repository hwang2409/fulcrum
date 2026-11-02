import { expect, test } from "bun:test";
import type { RunEvent } from "@fulcrum/core";
import { replayStep } from "../src/replay";

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
