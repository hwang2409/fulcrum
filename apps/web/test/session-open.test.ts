import { expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { openSession } from "../src/session";
import type { ZetaClient } from "@fulcrum/zeta";

// The live rows must remain buffered across every request in the open transaction.
test("openSession keeps live events that overlap status and resume", async () => {
  const store = createRunStore();
  let buffering: Array<{ type: "message_delta"; message_id: string; delta: string; kind: string }> | null = null;
  const client = {
    features: [],
    request(method: string) {
      const event = { type: "message_delta" as const, message_id: method, delta: method, kind: "assistant" };
      if (buffering) buffering.push(event);
      else store.dispatch(event);
      if (method === "status") return Promise.resolve({ session: null, state: "idle", pending_approvals: [] });
      if (method === "resume") return Promise.resolve({});
      return Promise.resolve({ messages: [], next_offset: null });
    },
    replay: async (_id: string, load: () => Promise<unknown[]>) => {
      const waiting: typeof buffering = [];
      buffering = waiting;
      const history = await load();
      buffering = null;
      for (const event of history) store.dispatch(event as never);
      for (const event of waiting) store.dispatch(event);
      return { store, release() {} };
    },
  } as unknown as ZetaClient;

  const lease = await openSession(client, "s1");
  const text = lease.store.getOutline().map(({ id }) => lease.store.getItem(id)).filter((item) => item?.type === "message").map((item) => item?.text).join(" ");
  expect(text).toContain("status");
  expect(text).toContain("resume");
  lease.release();
});
