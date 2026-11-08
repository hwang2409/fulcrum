import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { RunProvider, Timeline } from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());
let root: Root | undefined;
let container: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

function timeline(...data: (Record<string, unknown> | undefined)[]) {
  const store = createRunStore(() => {});
  data.forEach((value, index) => store.dispatch({ type: "notification", notification_id: `n${index}`, data: value } as RunEvent));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RunProvider store={store}><Timeline /></RunProvider>));
}
const row = (index: number) => container.querySelector<HTMLElement>(`[data-id="notification:${index}"]`)!;
const facts = (index: number) => [...row(index).querySelectorAll("dt")].map((term) => `${term.textContent}=${term.nextElementSibling?.textContent}`);

test("a notification is its own labelled part with a one-line summary and no disclosure when nothing more is known", () => {
  timeline({ text: "Context compacted" }, { count: 3 }, undefined);
  const plain = row(1);
  expect(plain.dataset.part).toBe("notification");
  expect(plain.dataset.kind).toBe("notification");
  expect(plain.getAttribute("role")).toBe("group");
  expect(plain.getAttribute("aria-label")).toBe("notification");
  expect(plain.querySelector('[data-part="notification-summary"]')!.textContent).toBe("Context compacted");
  expect(plain.querySelector("details, summary, dl")).toBeNull();
  // No recognized text: the row still says what it is, once.
  for (const index of [2, 3]) {
    expect(row(index).dataset.part).toBe("notification");
    expect(row(index).textContent).toBe("notification");
  }
});

test("recognized scalar metadata opens behind a keyboard disclosure; everything else stays out of the DOM", () => {
  timeline({
    summary: "worker finished",
    kind: "agent_completion",
    status: "completed",
    timestamp: "2026-11-08T10:15:00Z",
    token: "SECRET-token",
    payload: { nested: "SECRET-nested" },
    list: ["SECRET-list"],
  }, { text: "epoch seconds", time: 1_762_596_900 }, { text: "epoch ms", created_at: 1_762_596_900_000 });
  const card = row(1) as HTMLDetailsElement;
  expect(card.tagName).toBe("DETAILS");
  expect(card.dataset.part).toBe("notification");
  expect(card.getAttribute("aria-label")).toBe("notification");
  expect(card.dataset.status).toBe("completed");
  const summary = card.querySelector("summary")!;
  expect(summary.dataset.part).toBe("notification-summary");
  expect(summary.textContent).toBe("worker finished");
  expect(facts(1)).toEqual(["kind=agent_completion", "status=completed", `time=${new Date("2026-11-08T10:15:00Z").toLocaleString()}`]);
  expect(card.querySelector("time")!.getAttribute("datetime")).toBe("2026-11-08T10:15:00.000Z");
  expect(card.textContent).not.toContain("SECRET");
  expect(card.textContent).not.toContain("{");
  // Seconds and milliseconds since the epoch name the same moment.
  expect(row(2).querySelector("time")!.getAttribute("datetime")).toBe("2025-11-08T10:15:00.000Z");
  expect(row(3).querySelector("time")!.getAttribute("datetime")).toBe("2025-11-08T10:15:00.000Z");
});

test("a long or multi-line notification keeps a bounded one-line summary and its full text behind the disclosure", () => {
  const long = "x".repeat(5_000);
  timeline({ text: long }, { message: "first line\nsecond line" });
  const summary = row(1).querySelector('[data-part="notification-summary"]')!.textContent!;
  expect(summary.length).toBeLessThanOrEqual(240);
  expect(summary.endsWith("…")).toBe(true);
  expect(row(1).querySelector('[data-part="notification-text"]')!.textContent).toBe(long);
  expect(row(2).querySelector('[data-part="notification-summary"]')!.textContent).toBe("first line");
  expect(row(2).querySelector('[data-part="notification-text"]')!.textContent).toBe("first line\nsecond line");
});

test("cyclic, nested, malformed, and throwing data neither throws nor appears", () => {
  const cyclic: Record<string, unknown> = { text: "cyclic stays readable" };
  cyclic.self = cyclic;
  cyclic.kind = { name: "SECRET-kind" };
  cyclic.status = 7;
  cyclic.timestamp = "SECRET-not-a-date";
  const throwing = Object.defineProperty({ title: "getter safe" }, "status", { enumerable: true, get() { throw new Error("SECRET-getter"); } });
  timeline(cyclic, throwing, { text: "  ", message: 5, kind: "", status: "   ", time: Number.NaN, at: 8.64e15 * 10 }, { text: "far", timestamp: 1e300 });
  expect(row(1).textContent).toBe("cyclic stays readable");
  expect(row(1).querySelector("details, summary")).toBeNull();
  expect(row(2).textContent).toBe("getter safe");
  expect(row(3).textContent).toBe("notification");
  expect(row(4).textContent).toBe("far");
  expect(container.textContent).not.toContain("SECRET");
});
