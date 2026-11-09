import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore } from "@fulcrum/core";
import { Composer, RunProvider, type ComposerProps } from "../src/index.js";
import { unsentDraft } from "../src/composer.js";

afterAll(() => GlobalRegistrator.unregister());

let root: Root | undefined;
let container: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});
function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<StrictMode>{node}</StrictMode>));
  return container;
}
const render = (node: ReactNode) => act(() => root!.render(<StrictMode>{node}</StrictMode>));
const q = (selector: string) => container.querySelector(selector) as HTMLElement | null;
const field = () => q("textarea") as HTMLTextAreaElement;
const submit = () => q('[data-part="composer-submit"]') as HTMLButtonElement;
const stop = () => q('[data-part="composer-stop"]') as HTMLButtonElement | null;
const status = () => q('[data-part="composer-message"]')!;

/** Types like a user: React reads the native value setter, then an input event. */
function type(value: string) {
  const input = field();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
}
function key(init: KeyboardEventInit & { keyCode?: number }) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  act(() => { field().dispatchEvent(event); });
  return event;
}
const enter = (init: KeyboardEventInit & { keyCode?: number } = {}) => key({ key: "Enter", code: "Enter", ...init });
const click = (button: HTMLElement) => act(() => { button.click(); });
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function calls(result: () => Promise<unknown> = () => Promise.resolve()) {
  const seen: Array<[string, { steer: boolean }]> = [];
  const onSubmit: ComposerProps["onSubmit"] = (text, intent) => { seen.push([text, intent]); return result(); };
  return { seen, onSubmit };
}

test("Enter submits; Shift+Enter is left to the textarea as a newline", async () => {
  const { seen, onSubmit } = calls();
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  type("line one");
  const shifted = enter({ shiftKey: true });
  expect(shifted.defaultPrevented).toBe(false);
  expect(seen).toEqual([]);
  const plain = enter();
  expect(plain.defaultPrevented).toBe(true);
  await settle();
  expect(seen).toEqual([["line one", { steer: false }]]);
});

test("Enter during IME composition never submits (isComposing or keyCode 229)", () => {
  const { seen, onSubmit } = calls();
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  type("にほん");
  expect(enter({ isComposing: true }).defaultPrevented).toBe(false);
  expect(enter({ keyCode: 229 }).defaultPrevented).toBe(false);
  expect(seen).toEqual([]);
});

test("a blank draft does not submit", () => {
  const { seen, onSubmit } = calls();
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  type("  \n ");
  enter();
  click(submit());
  expect(seen).toEqual([]);
  expect(submit().getAttribute("aria-disabled")).toBe("true");
});

test("rapid clicks and keys call onSubmit once while a submit is in flight", async () => {
  const pending = deferred();
  const { seen, onSubmit } = calls(() => pending.promise);
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  type("once");
  act(() => {
    submit().click();
    submit().click();
  });
  enter();
  enter();
  click(submit());
  expect(seen.length).toBe(1);
  expect(q('[data-part="composer"]')!.getAttribute("aria-busy")).toBe("true");
  expect(submit().getAttribute("aria-disabled")).toBe("true");
  await act(async () => { pending.resolve(); await pending.promise; });
  expect(seen.length).toBe(1);
});

test("a rejected submit keeps the text, announces the error politely, and a retry sends again", async () => {
  let attempt = 0;
  const { seen, onSubmit } = calls(() => (attempt++ === 0 ? Promise.reject(new Error("socket closed")) : Promise.resolve()));
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  type("keep me");
  enter();
  await settle();
  expect(field().value).toBe("keep me");
  expect(status().textContent).toBe("could not send: socket closed");
  expect(status().getAttribute("role")).toBe("status");
  expect(q('[data-part="composer"]')!.dataset.error).toBe("submit");
  // The error is part of the field's description, so a screen reader also hears it on focus.
  expect(field().getAttribute("aria-describedby")!.split(" ")).toContain(status().id);
  enter();
  await settle();
  expect(seen.map(([text]) => text)).toEqual(["keep me", "keep me"]);
  expect(field().value).toBe("");
  expect(status().textContent).toBe("");
});

test("an accepted submit clears the draft once; text typed meanwhile after the sent text is kept", async () => {
  const pending = deferred();
  const { onSubmit } = calls(() => pending.promise);
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  type("first");
  enter();
  type("first\nand more");
  await act(async () => { pending.resolve(); await pending.promise; });
  expect(field().value).toBe("\nand more");
});

test("an accepted submit keeps the exact unsent suffix, blank lines and indentation included", async () => {
  const pending = deferred();
  const { onSubmit } = calls(() => pending.promise);
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  type("first");
  enter();
  type("first\n\n  indented");
  await act(async () => { pending.resolve(); await pending.promise; });
  expect(field().value).toBe("\n\n  indented");
});

test("unsentDraft removes exactly the sent prefix and never normalizes the rest", () => {
  expect(unsentDraft("first", "first")).toBe("");
  expect(unsentDraft("first\n\n  indented", "first")).toBe("\n\n  indented");
  expect(unsentDraft("first  ", "first")).toBe("  ");
  // A middle edit changes the sent prefix, so nothing of the draft was sent: it stays whole.
  expect(unsentDraft("fi-rst and more", "first")).toBe("fi-rst and more");
  expect(unsentDraft("", "first")).toBe("");
});

test("an accepted submit keeps a draft the user rewrote meanwhile", async () => {
  const pending = deferred();
  const { onSubmit } = calls(() => pending.promise);
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  type("first");
  enter();
  type("rewritten");
  await act(async () => { pending.resolve(); await pending.promise; });
  expect(field().value).toBe("rewritten");
});

test("the textarea keeps focus after a click submit and after it settles", async () => {
  const { onSubmit } = calls();
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  type("focus");
  submit().focus();
  click(submit());
  expect(document.activeElement).toBe(field());
  await settle();
  expect(document.activeElement).toBe(field());
  expect(field().disabled).toBe(false);
});

test("the label is send when idle and steer while a steerable turn runs", async () => {
  const { seen, onSubmit } = calls();
  mount(<Composer state="idle" onSubmit={onSubmit} />);
  expect(submit().textContent).toBe("send");
  expect(submit().getAttribute("aria-label")).toBe("send message");
  render(<Composer state="steerable" onSubmit={onSubmit} onStop={() => {}} />);
  expect(submit().textContent).toBe("steer");
  expect(submit().getAttribute("aria-label")).toBe("steer the running turn");
  expect(submit().dataset.action).toBe("steer");
  type("also run the tests");
  enter();
  await settle();
  expect(seen).toEqual([["also run the tests", { steer: true }]]);
});

test("a running turn that cannot be steered disables submit and keeps the draft (no queue)", () => {
  const { seen, onSubmit } = calls();
  mount(<Composer state="running" onSubmit={onSubmit} onStop={() => {}} />);
  type("later");
  expect(enter().defaultPrevented).toBe(true); // Enter never adds a newline, even when it cannot submit
  click(submit());
  expect(seen).toEqual([]);
  expect(submit().textContent).toBe("send");
  expect(submit().getAttribute("aria-disabled")).toBe("true");
  expect(field().value).toBe("later");
  expect(q('[data-part="composer-hint"]')!.textContent).toContain("stop it or wait");
});

test("stop shows only while a turn runs, has a pending state, and calls onStop once", async () => {
  const pending = deferred();
  let stops = 0;
  const onStop = () => { stops++; return pending.promise; };
  mount(<Composer state="idle" onSubmit={() => Promise.resolve()} onStop={onStop} />);
  expect(stop()).toBe(null);
  render(<Composer state="steerable" onSubmit={() => Promise.resolve()} onStop={onStop} />);
  expect(stop()!.getAttribute("aria-label")).toBe("stop the running turn");
  click(stop()!);
  click(stop()!);
  expect(stops).toBe(1);
  expect(stop()!.textContent).toBe("stopping");
  expect(stop()!.getAttribute("aria-disabled")).toBe("true");
  expect(status().textContent).toBe("stopping");
  await act(async () => { pending.resolve(); await pending.promise; });
  expect(stop()!.textContent).toBe("stop");
});

test("a failed stop shows its error and can be retried", async () => {
  let stops = 0;
  const onStop = () => (stops++ === 0 ? Promise.reject(new Error("timed out")) : undefined);
  mount(<Composer state="running" onSubmit={() => Promise.resolve()} onStop={onStop} />);
  click(stop()!);
  await settle();
  expect(status().textContent).toBe("could not stop: timed out");
  expect(q('[data-part="composer"]')!.dataset.error).toBe("stop");
  click(stop()!);
  await settle();
  expect(stops).toBe(2);
  expect(status().textContent).toBe("");
});

test("read-only hides every action and says why; the draft stays on screen, read-only, and survives", () => {
  const { onSubmit } = calls();
  mount(<Composer state="idle" onSubmit={onSubmit} onStop={() => {}} />);
  type("draft");
  render(<Composer state="read-only" reason="observing: another client controls this run" onSubmit={onSubmit} onStop={() => {}} />);
  expect(field().value).toBe("draft");
  expect(field().readOnly).toBe(true);
  expect(container.querySelectorAll("button").length).toBe(0);
  expect(q('[data-part="composer"]')!.dataset.state).toBe("read-only");
  expect(q('[data-part="composer-reason"]')!.textContent).toBe("observing: another client controls this run");
  render(<Composer state="idle" onSubmit={onSubmit} />);
  expect(field().value).toBe("draft");
  expect(field().readOnly).toBe(false);
});

test("read-only with no draft shows only the reason", () => {
  mount(<Composer state="read-only" reason="observing" onSubmit={() => Promise.resolve()} />);
  expect(q("textarea")).toBe(null);
  expect(q('[data-part="composer-reason"]')!.textContent).toBe("observing");
});

test("when the focused stop button goes away at the end of the turn, focus moves to the field", () => {
  mount(<Composer state="steerable" onSubmit={() => Promise.resolve()} onStop={() => {}} />);
  act(() => stop()!.focus());
  render(<Composer state="steerable" onSubmit={() => Promise.resolve()} onStop={() => {}} />);
  expect(document.activeElement).toBe(stop());
  render(<Composer state="idle" onSubmit={() => Promise.resolve()} onStop={() => {}} />);
  expect(stop()).toBe(null);
  expect(document.activeElement).toBe(field());
});

test("the field has a name, starts from defaultValue, and the grow mirror carries the draft", () => {
  mount(<Composer state="idle" label="message zeta" defaultValue="restored" onSubmit={() => Promise.resolve()} />);
  expect(field().getAttribute("aria-label")).toBe("message zeta");
  expect(field().value).toBe("restored");
  type("a\nb\n");
  expect(q('[data-part="composer-field"]')!.dataset.value).toBe("a\nb\n");
});

test("when the composer goes read-only while stop has focus, focus moves to the read-only composer, not the page", () => {
  mount(<Composer state="steerable" onSubmit={() => Promise.resolve()} onStop={() => {}} />);
  act(() => stop()!.focus());
  render(<Composer state="read-only" reason="reconnecting" onSubmit={() => Promise.resolve()} />);
  expect(document.activeElement).toBe(q('[data-part="composer"]'));
});

/** A host whose send reply waits while the run already shows zeta's echo of the message (the user_message with its delivery id). */
function echoFirst(result: () => Promise<unknown>) {
  const store = createRunStore((flush) => flush());
  const seen: string[] = [];
  const onSubmit: ComposerProps["onSubmit"] = (text, _intent, trackDelivery) => {
    seen.push(text);
    trackDelivery?.("d1");
    return result();
  };
  const echo = () => act(() => store.dispatch({ type: "user_message", text: seen[0]!, mode: "send", delivery_id: "d1" }));
  return { store, seen, onSubmit, echo };
}

test("the echo of the sent message clears the draft before the send reply; Enter in the gap sends nothing", async () => {
  const reply = deferred();
  const { store, seen, onSubmit, echo } = echoFirst(() => reply.promise);
  mount(<RunProvider store={store}><Composer state="idle" onSubmit={onSubmit} /></RunProvider>);
  type("hello");
  enter();
  await settle();
  expect(field().value).toBe("hello");
  echo();
  expect(field().value).toBe("");
  // Between the echo and the reply: Enter (even with new text typed) never sends a second time.
  enter();
  type("next");
  enter();
  await settle();
  expect(seen).toEqual(["hello"]);
  await act(async () => { reply.resolve(); await reply.promise; });
  // The reply clears nothing more: the new draft stays whole.
  expect(field().value).toBe("next");
  expect(status().textContent).toBe("");
});

test("only the first delivery id tracked for an attempt can confirm it", async () => {
  const reply = deferred();
  const store = createRunStore((flush) => flush());
  const onSubmit: ComposerProps["onSubmit"] = (_text, _intent, trackDelivery) => {
    trackDelivery("real-id");
    trackDelivery("stale-id");
    return reply.promise;
  };
  mount(<RunProvider store={store}><Composer state="idle" onSubmit={onSubmit} /></RunProvider>);
  type("hello");
  enter();
  await settle();
  act(() => store.dispatch({ type: "user_message", text: "hello", mode: "send", delivery_id: "real-id" }));
  expect(field().value).toBe("");
  await act(async () => { reply.resolve(); await reply.promise; });
});

test("the echo clears only the sent part; text typed after it stays", async () => {
  const reply = deferred();
  const { store, onSubmit, echo } = echoFirst(() => reply.promise);
  mount(<RunProvider store={store}><Composer state="idle" onSubmit={onSubmit} /></RunProvider>);
  type("hello");
  enter();
  type("hello\nmore");
  echo();
  expect(field().value).toBe("\nmore");
  // A draft that again starts with the sent text is not cut a second time when the reply comes.
  type("hello again");
  await act(async () => { reply.resolve(); await reply.promise; });
  expect(field().value).toBe("hello again");
});

test("a reply that fails before the echo notification flushes is not a failure: the message reached the run", async () => {
  const reply = deferred();
  let flush: (() => void) | undefined;
  const store = createRunStore((job) => { flush = job; });
  const onSubmit: ComposerProps["onSubmit"] = (_text, _intent, trackDelivery) => {
    trackDelivery("d1");
    return reply.promise;
  };
  mount(<RunProvider store={store}><Composer state="idle" onSubmit={onSubmit} /></RunProvider>);
  type("hello");
  enter();
  await settle();
  // The reply rejects while React still has not seen the scheduled store notification.
  await act(async () => {
    store.dispatch({ type: "user_message", text: "hello", mode: "send", delivery_id: "d1" });
    reply.reject(new Error("timed out"));
    await reply.promise.catch(() => {});
  });
  act(() => flush?.());
  expect(field().value).toBe("");
  expect(status().textContent).toBe("");
  expect(q('[data-part="composer"]')!.dataset.error).toBeUndefined();
});

test("with no echo, a failed send keeps the draft for a retry, and an echo after the failure changes nothing", async () => {
  const { store, seen, onSubmit, echo } = echoFirst(() => Promise.reject(new Error("socket closed")));
  mount(<RunProvider store={store}><Composer state="idle" onSubmit={onSubmit} /></RunProvider>);
  type("hello");
  enter();
  await settle();
  expect(field().value).toBe("hello");
  expect(status().textContent).toBe("could not send: socket closed");
  echo();
  expect(field().value).toBe("hello");
  expect(seen).toEqual(["hello"]);
});

test("an id the run already has (a retry whose first attempt landed) clears the draft at once", async () => {
  const reply = deferred();
  const { store, onSubmit } = echoFirst(() => reply.promise);
  store.dispatch({ type: "user_message", text: "hello", mode: "send", delivery_id: "d1" });
  mount(<RunProvider store={store}><Composer state="idle" onSubmit={onSubmit} /></RunProvider>);
  type("hello");
  enter();
  await settle();
  expect(field().value).toBe("");
  await act(async () => { reply.resolve(); await reply.promise; });
});
