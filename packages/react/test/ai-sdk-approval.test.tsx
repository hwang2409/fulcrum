import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore } from "@fulcrum/core";
import { decodeAiSdkMessage, respondToApproval, type AiSdkApprovalResponse, type AiSdkApprovalTarget } from "../../ai-sdk/src/index.js";
import { TestChat } from "../../ai-sdk/test/chat.js";
import { Approval, RunProvider } from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());
let root: Root | undefined;
let container: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

// A persisted assistant message whose tool waits for approval, as a real ai 6.0.0 chat keeps it.
const asking = {
  id: "m", role: "assistant" as const,
  parts: [{ type: "step-start" as const }, { type: "tool-rm" as const, toolCallId: "c1", state: "approval-requested" as const, input: { path: "a" }, approval: { id: "approval-1" } }],
};

/** The host wiring the README shows: a real AI SDK chat, the adapter's rows in a store, an Approval card. */
function host(chat: AiSdkApprovalTarget["chat"]) {
  const store = createRunStore((flush) => flush());
  for (const event of decodeAiSdkMessage(asking)) store.dispatch(event);
  const target = { chat, dispatch: store.dispatch };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <RunProvider store={store}>
      <Approval
        id="approval:w:approval:approval-1"
        onApprove={(requestId) => respondToApproval(target, { requestId, approved: true })}
        onDeny={(requestId) => respondToApproval(target, { requestId, approved: false })}
      />
    </RunProvider>,
  ));
  const card = container.querySelector<HTMLElement>('[data-part="approval"]')!;
  const click = async (action: "approve" | "deny") => {
    act(() => card.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const enabled = () => [...card.querySelectorAll<HTMLButtonElement>('[data-part="approval-actions"] button')].map((button) => button.getAttribute("aria-disabled") === null && !button.disabled);
  return { card, click, enabled, alert: () => card.querySelector('[role="alert"]')?.textContent };
}

test("an approval left behind by a new prompt: respondToApproval rejects, and the card shows why and offers its buttons again", async () => {
  // The user sent a new prompt, so the approval is no longer in the chat's last message: the SDK would ignore it.
  const chat = new TestChat(async () => [], [asking, { id: "u2", role: "user", parts: [{ type: "text", text: "never mind" }] }]);
  const { card, click, enabled, alert } = host(chat);
  for (const action of ["approve", "deny"] as const) {
    await click(action);
    expect(alert()).toBe("this approval is no longer waiting for a decision");
    expect(card.getAttribute("data-state")).toBe("pending");
    expect(enabled()).toEqual([true, true]);
  }
});

test("the SDK refuses the decision: the card shows the SDK's error, offers its buttons again, and a retry ends it", async () => {
  const chat = new TestChat(async () => [], [asking]);
  let refuse = true;
  const flaky = {
    get messages() { return chat.messages; },
    addToolApprovalResponse: (response: AiSdkApprovalResponse) => refuse ? Promise.reject(new Error("could not save the decision")) : chat.addToolApprovalResponse(response),
  };
  const { card, click, enabled, alert } = host(flaky);
  await click("approve");
  expect(alert()).toBe("could not save the decision");
  expect(card.getAttribute("data-state")).toBe("pending");
  expect(enabled()).toEqual([true, true]);
  refuse = false;
  await click("approve");
  expect(card.getAttribute("data-state")).toBe("done");
  expect(alert()).toBeUndefined();
  expect(chat.messages.at(-1)!.parts.at(-1)).toMatchObject({ state: "approval-responded", approval: { id: "approval-1", approved: true } });
});
