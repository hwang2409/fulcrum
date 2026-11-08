import { expect, test } from "bun:test";
import { createRunStore } from "../src/index.js";

const DELTAS = 10_000;

test("reasoning stream does not eagerly recopy prior characters", () => {
  const store = createRunStore((flush) => flush());
  let eagerCharacters = 0;

  for (let index = 0; index < DELTAS; index++) {
    store.dispatch({
      type: "message_delta",
      message_id: "reasoning",
      kind: "reasoning",
      delta: "x",
    });
    const item = store.getItem("message:reasoning");
    const block = item?.type === "message" ? item.message.content[0] : undefined;
    const descriptor = block && Object.getOwnPropertyDescriptor(block, "text");
    if (typeof descriptor?.value === "string") eagerCharacters += descriptor.value.length;
  }

  const item = store.getItem("message:reasoning");
  expect(eagerCharacters).toBeLessThanOrEqual(DELTAS);
  expect(item?.type === "message" ? item.message.content[0]?.text : undefined).toBe("x".repeat(DELTAS));
  store.dispose();
});
