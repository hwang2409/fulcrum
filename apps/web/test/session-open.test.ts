import { expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { openSession } from "../src/session";
import type { ZetaClient } from "@fulcrum/zeta";

// Without session_replay_seq, every event in the ambiguous history window is quarantined.
test("openSession drops overlapping events and keeps the paged snapshot exact", async () => {
  let store = createRunStore();
  let buffering: Array<{ type: "message_delta" | "approval_request"; message_id?: string; delta?: string; kind?: string; request_id?: string; tool_call?: { id: string; name: string; arguments: Record<string, never> }; delegated?: boolean }> | null = null;
  let requestCount = 0;
  const inject = (stage: string) => {
    const events = [
      { type: "message_delta" as const, message_id: `message-${stage}`, delta: stage, kind: "assistant" },
      { type: "approval_request" as const, request_id: `approval-${stage}`, tool_call: { id: `tool-${stage}`, name: "bash", arguments: {} }, delegated: false },
    ];
    for (const event of events) {
      if (buffering) buffering.push(event);
      else store.dispatch(event);
    }
  };
  const client = {
    features: [],
    request(method: string, params?: { offset?: number }) {
      const sequence = ++requestCount;
      const stage = method === "status" ? `status-${sequence}` : method === "resume" ? `resume-${sequence}` : `history-${sequence}`;
      inject(stage);
      if (method === "status") return Promise.resolve({ session: null, state: "idle", pending_approvals: [] });
      if (method === "resume") return Promise.resolve({});
      const offset = params?.offset ?? 0;
      return Promise.resolve({
        messages: [{ id: `history-row-${offset}`, role: "user", content: [{ type: "text", text: `history-page-${offset}` }], tool_result: null }],
        next_offset: offset === 0 ? 1 : null,
      });
    },
    replay: async (_id: string, load: () => Promise<unknown[]>) => {
      buffering = [];
      const history = await load();
      store = createRunStore();
      for (const event of history) store.dispatch(event as never);
      return { store, release() {} };
    },
    finishReplay: () => { buffering = null; },
  } as unknown as ZetaClient;

  const opened = await openSession(client, "s1");
  await opened.complete;
  const lease = opened.lease;
  const outline = lease.store.getOutline();
  const ids = outline.map(({ id }) => id);
  const messages = outline
    .map(({ id }) => lease.store.getItem(id))
    .filter((item) => item?.type === "message")
    .map((item) => item?.text ?? "");
  const approvals = outline
    .map(({ id }) => lease.store.getItem(id))
    .filter((item) => item?.type === "approval");
  const historyItems = outline
    .map(({ id }) => lease.store.getItem(id))
    .filter((item) => item?.type === "user")
    .map((item) => item?.type === "user" && item.event.type === "user_message" ? item.event.text : "");

  expect(messages).toHaveLength(0);
  expect(historyItems).toEqual(["history-page-0", "history-page-1"]);
  expect(approvals).toHaveLength(0);
  expect(new Set(ids).size).toBe(ids.length);
  lease.release();
});
