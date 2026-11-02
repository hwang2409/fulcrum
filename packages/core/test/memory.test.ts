import { expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { createRunStore } from "../src/index.js";

const DELTAS = 50_000;
const DELTA = "x".repeat(100);
const FINAL_TEXT_BYTES = DELTAS * DELTA.length;
const RETAINED_HEAP_LIMIT = FINAL_TEXT_BYTES * 3 + 8_000_000;

test(
  "frame reads do not retain historical full strings",
  () => {
    Bun.gc(true);
    const baseline = heapStats().heapSize;
    const store = createRunStore(undefined, () => {});

    for (let i = 0; i < DELTAS; i++) {
      store.dispatch({
        type: "message_delta",
        message_id: "memory",
        delta: DELTA,
      });
      if ((i + 1) % 4 === 0) {
        const item = store.getItem("message:memory");
        if (
          item?.type !== "message" ||
          item.text?.length !== (i + 1) * DELTA.length ||
          item.text.at(-1) !== "x"
        )
          throw new Error("stream read did not include every delta");
      }
    }

    Bun.gc(true);
    const retained = heapStats().heapSize - baseline;
    store.dispose();

    expect(retained).toBeLessThan(RETAINED_HEAP_LIMIT);
  },
  30_000,
);
