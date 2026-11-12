import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { domShimAlarm, shimProperty } from "../../../test-support/dom-shim.js";
domShimAlarm(import.meta.path);
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { RunProvider, ToolCall } from "../src/index.js";
import { sourceText } from "../src/tools/common.js";

afterAll(() => GlobalRegistrator.unregister());
let root: Root | undefined;
let container: HTMLElement;
const restores: Array<() => void> = [];
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  restores.splice(0).reverse().forEach((restore) => restore());
});

type Store = ReturnType<typeof createRunStore>;
const call = { id: "log", name: "bash", arguments: {} };
const outputEvent = (output: string, replace = false): RunEvent => ({ type: "tool_output", tool_call: call, output, replace });
function mountOutput(output: string, itemBytes?: number): Store {
  const store = createRunStore((flush) => flush(), itemBytes ? { toolOutputItemBytes: itemBytes } : undefined);
  store.dispatch({ type: "tool_start", tool_call: call, view: { kind: "shell", command: "log" } });
  store.dispatch(outputEvent(output));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RunProvider store={store}><ToolCall id="tool:log" /></RunProvider>));
  const card = container.querySelector<HTMLDetailsElement>('[data-id="tool:log"]')!;
  act(() => {
    card.open = true;
    card.dispatchEvent(new Event("toggle"));
  });
  act(() => container.querySelector<HTMLButtonElement>('[data-action="open-viewer"]')!.click());
  return store;
}
const q = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector);
const status = () => q('[data-part="text-viewer-find-count"]')?.textContent ?? null;
async function until(test: () => boolean, ms = 5_000) {
  const end = performance.now() + ms;
  while (!test()) {
    if (performance.now() > end) throw new Error(`timed out; find says ${JSON.stringify(status())}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
/** Types like a user: the native value setter, then an input event (and a keyup, which React's input polyfill reads). */
const type = (value: string) => {
  const input = q<HTMLInputElement>('[data-part="text-viewer-find"] > input')!;
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
};
/** Counts AbortController aborts, to see that a superseded or unmounted search is stopped. */
function countAborts() {
  const counter = { value: 0 };
  const abort = AbortController.prototype.abort;
  restores.push(shimProperty(AbortController.prototype, "abort", {
    configurable: true,
    writable: true,
    value(this: AbortController, reason?: unknown) {
      counter.value++;
      return abort.call(this, reason);
    },
  }));
  return counter;
}
// 6,000 lines: about 140 kB, so the viewer draws a small part and a whole-text search takes several work slices.
const lines = (count: number, word = "match") => Array.from({ length: count }, (_, index) => `${index} ${index % 3 === 0 ? word : "other"} line\n`).join("");

test("ctrl+f finds in the whole text, enter and shift+enter move, escape closes and gives focus back", async () => {
  mountOutput(lines(6_000));
  const viewer = q('[data-part="text-viewer"]')!;
  expect(container.querySelectorAll('[data-part="text-viewer-row"]').length).toBeLessThan(200);
  viewer.focus();
  press(viewer, "f", { ctrlKey: true });
  const input = q<HTMLInputElement>('[data-part="text-viewer-find"] > input')!;
  expect(document.activeElement).toBe(input);
  type("MATCH");
  await until(() => status() === "1 of 2,000");
  press(input, "Enter");
  expect(status()).toBe("2 of 2,000");
  press(input, "Enter", { shiftKey: true });
  press(input, "Enter", { shiftKey: true });
  expect(status()).toBe("2,000 of 2,000");
  // The last match is far below the drawn rows: moving to it scrolled the viewer there.
  expect(viewer.scrollTop).toBeGreaterThan(0);
  expect(q('[data-part="text-viewer-announce"]')!.textContent).toBe("2,000 of 2,000");
  press(input, "Escape");
  expect(q('[data-part="text-viewer-find"]')).toBeNull();
  expect(document.activeElement).toBe(viewer);
  // Opened again, the bar keeps its query to type over.
  press(viewer, "f", { metaKey: true });
  expect(q<HTMLInputElement>('[data-part="text-viewer-find"] > input')!.value).toBe("MATCH");
});

test("a new query aborts the search in flight, and its results never show", async () => {
  const aborts = countAborts();
  mountOutput(lines(6_000));
  act(() => q<HTMLButtonElement>('[data-action="find"]')!.click());
  type("line");
  type("match line");
  expect(aborts.value).toBeGreaterThanOrEqual(1);
  await until(() => status() === "1 of 2,000");
  // A stale "line" result (6,000 matches) would overwrite it here if the first search had kept running.
  for (let step = 0; step < 20; step++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  expect(status()).toBe("1 of 2,000");
});

test("unmounting while a search runs aborts it", async () => {
  const aborts = countAborts();
  mountOutput(lines(6_000));
  act(() => q<HTMLButtonElement>('[data-action="find"]')!.click());
  type("other");
  await until(() => status() !== "searching" && status() !== "");
  const before = aborts.value;
  act(() => root!.unmount());
  root = undefined;
  expect(aborts.value).toBe(before + 1);
});

test("new output is searched again and keeps the current match", async () => {
  const store = mountOutput(lines(600));
  act(() => q<HTMLButtonElement>('[data-action="find"]')!.click());
  type("match");
  await until(() => status() === "1 of 200");
  press(q('[data-part="text-viewer-find"] > input')!, "Enter");
  expect(status()).toBe("2 of 200");
  act(() => store.dispatch(outputEvent("600 match line\n")));
  await until(() => status() === "2 of 201");
  // A replaced text is searched from scratch.
  act(() => store.dispatch(outputEvent(lines(600, "other"), true)));
  await until(() => status() === "no matches");
});

test("a cut output: find and export say retained, and export saves the kept text with its cut line", async () => {
  const saved: Blob[] = [];
  const names: string[] = [];
  const revoked: string[] = [];
  restores.push(shimProperty(URL, "createObjectURL", { configurable: true, writable: true, value: (blob: Blob) => { saved.push(blob); return `blob:find-${saved.length}`; } }));
  restores.push(shimProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: (url: string) => { revoked.push(url); } }));
  restores.push(shimProperty(HTMLAnchorElement.prototype, "click", { configurable: true, writable: true, value(this: HTMLAnchorElement) { names.push(this.download); } }));
  const store = mountOutput(lines(6_000), 64 * 1024);
  const item = store.getItem("tool:log");
  if (item?.type !== "tool") throw new Error("missing tool");
  expect(item.output.omission).not.toBeNull();
  const button = q<HTMLButtonElement>('[data-action="export"]')!;
  expect(button.textContent).toBe("export retained");
  expect(button.getAttribute("aria-label")).toBe("export retained output");
  act(() => button.click());
  expect(names).toEqual(["output-retained.txt"]);
  expect(await saved[0]!.text()).toBe(sourceText(item.output));
  expect(await saved[0]!.text()).toContain("not kept");
  expect(button.textContent).toBe("exported retained");
  await until(() => revoked.length === 1);
  act(() => q<HTMLButtonElement>('[data-action="find"]')!.click());
  type("match");
  await until(() => /of [\d,]+ in retained text$/.test(status() ?? ""));
  type("no such text");
  await until(() => status() === "no matches in retained text");
});

test("a complete output exports without the retained word", () => {
  const names: string[] = [];
  restores.push(shimProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "blob:x" }));
  restores.push(shimProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => {} }));
  restores.push(shimProperty(HTMLAnchorElement.prototype, "click", { configurable: true, writable: true, value(this: HTMLAnchorElement) { names.push(this.download); } }));
  mountOutput(lines(600));
  const button = q<HTMLButtonElement>('[data-action="export"]')!;
  expect(button.textContent).toBe("export");
  act(() => button.click());
  expect(names).toEqual(["output.txt"]);
});
