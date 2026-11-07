import { expect, test } from "bun:test";
import { servedTurnOutcome } from "../src/index.js";

test("servedTurnOutcome maps the newest served_turn_end to its turn's outcome", () => {
  // Shapes from zeta docs/serve-protocol.md (feature served_turn_end) and event_contract.served_turn_end_row.
  const end = (turnId: string, reason: string) => ({ id: `e-${turnId}`, role: "system", event: "served_turn_end", data: { turn_id: turnId, reason } });
  const rows = [
    { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], tool_result: null },
    end("5ec6b9bb4c8c44d29bfa315da83a4190", "user_stop"),
    { id: "a1", role: "assistant", content: [{ type: "text", text: "done" }], tool_result: null },
    end("a1b2c3d4e5f60718293a4b5c6d7e8f90", "completed"),
  ];
  expect(servedTurnOutcome(rows, "a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe("completed");
  // An older turn's end does not count: a newer turn ran after it.
  expect(servedTurnOutcome(rows, "5ec6b9bb4c8c44d29bfa315da83a4190")).toBeUndefined();
  expect(servedTurnOutcome([end("t", "user_stop")], "t")).toBe("cancelled");
  expect(servedTurnOutcome([end("t", "error")], "t")).toBe("failed");
  expect(servedTurnOutcome([end("t", "disconnect")], "t")).toBe("disconnected");
  expect(servedTurnOutcome(rows, "ffffffffffffffffffffffffffffffff")).toBeUndefined();
  expect(servedTurnOutcome([end("t", "exploded")], "t")).toBeUndefined();
});
