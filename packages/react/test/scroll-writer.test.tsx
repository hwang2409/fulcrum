import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualList, type VirtualListState } from "../src/index.js";

const SOURCE = new URL("../src/virtual.tsx", import.meta.url);

afterAll(() => GlobalRegistrator.unregister());

test("timeline scroll writes have one owner", () => {
  const source = readFileSync(SOURCE, "utf8");
  const writes = [...source.matchAll(/container\.(?:scrollTop\s*=|scrollTo\s*\(|scrollBy\s*\()/g)];
  expect(writes.length, "write timeline scroll positions only through writeScroll() in packages/react/src/virtual.tsx").toBe(1);
  const ownerStart = source.indexOf("const writeScroll =");
  const ownerEnd = source.indexOf("\n  };", ownerStart);
  expect(writes[0]!.index! > ownerStart && writes[0]!.index! < ownerEnd, "write timeline scroll positions only through writeScroll() in packages/react/src/virtual.tsx").toBeTrue();
});

type Row = { readonly id: string; readonly kind: "row" };
type Observer = { callback: ResizeObserverCallback; observed: Set<Element> };
type Scenario = {
  name: string;
  pinned: boolean;
  run(context: Context): void;
};
type Context = {
  host: HTMLElement;
  observers: Observer[];
  getList(): VirtualListState<string>;
  render(outline: readonly Row[], resetKey?: string): void;
  outline: readonly Row[];
};

const rows = (prefix = "row", count = 201): readonly Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, kind: "row" }));

const scenarios: readonly Scenario[] = [
  { name: "first load", pinned: true, run: () => {} },
  { name: "mutation finish", pinned: true, run: ({ render, outline }) => render([...outline, { id: "tail", kind: "row" }]) },
  { name: "stale-scroll restore", pinned: true, run: ({ host, getList }) => act(() => { getList().scrollToEnd(); host.dispatchEvent(new Event("scroll")); }) },
  { name: "layout snapshot replay", pinned: true, run: ({ render }) => render(rows("replay")) },
  { name: "viewport resize", pinned: true, run: ({ host, observers }) => {
    const observer = observers.find(({ observed }) => observed.has(host));
    expect(observer).toBeDefined();
    act(() => observer!.callback([], {} as ResizeObserver));
  } },
  { name: "jump button scrollToEnd", pinned: true, run: ({ getList }) => act(() => getList().scrollToEnd()) },
  { name: "requestFollow", pinned: true, run: ({ getList }) => act(() => { getList().scrollToId("row-100", 11); getList().requestFollow(); }) },
  { name: "reconnect store replacement", pinned: true, run: ({ render }) => render(rows("history"), "same-run") },
  { name: "late row measurement", pinned: true, run: ({ observers }) => {
    const observer = observers.find(({ observed }) => [...observed].some((element) => element.hasAttribute("data-virtual-id")));
    expect(observer).toBeDefined();
    const target = [...observer!.observed][0]!;
    act(() => observer!.callback([{ target, borderBoxSize: [{ blockSize: 72, inlineSize: 800 }], contentRect: { height: 72 } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
  } },
  { name: "anchor restore", pinned: false, run: ({ getList, render, outline }) => act(() => { getList().scrollToId("row-100", 11); render([{ id: "head", kind: "row" }, ...outline]); }) },
  { name: "mutation anchor correction", pinned: false, run: ({ getList, render, outline }) => act(() => { getList().scrollToId("row-100", 11); render([{ id: "head", kind: "row" }, ...outline]); }) },
  { name: "scrollToId", pinned: false, run: ({ getList }) => act(() => getList().scrollToId("row-100", 11)) },
];

function Harness({ outline, resetKey, expose }: {
  outline: readonly Row[];
  resetKey: string;
  expose(value: VirtualListState<string>): void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const list = useVirtualList(outline, { estimateSize: () => 72, scrollRef, resetKey });
  const initialScroll = useRef(true);
  useLayoutEffect(() => {
    if (initialScroll.current && list.snapshot.totalSize > 0) {
      initialScroll.current = false;
      list.scrollToEnd();
    }
  }, [list.scrollToEnd, list.snapshot.totalSize]);
  expose(list);
  return <div ref={scrollRef} data-test-scroll=""><div ref={list.timelineRef} style={{ height: list.snapshot.totalSize }}>
    {list.snapshot.rows.map((row) => <div key={row.id} ref={list.observeRow(row.id)} data-virtual-id={row.id} />)}
  </div></div>;
}

test.each(scenarios)("timeline routes $name through the DOM-aware scroll writer", (scenario) => {
  const observers: Observer[] = [];
  const saved = { ResizeObserver: globalThis.ResizeObserver, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  const descriptors = (["clientHeight", "scrollHeight", "scrollTop"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
  const positions = new WeakMap<HTMLElement, number>();
  globalThis.ResizeObserver = class {
    private entry: Observer;
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, observed: new Set() }; observers.push(this.entry); }
    observe(element: Element) { this.entry.observed.add(element); }
    unobserve(element: Element) { this.entry.observed.delete(element); }
    disconnect() { this.entry.observed.clear(); }
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (callback) => (callback(0), 1);
  globalThis.cancelAnimationFrame = () => {};
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (!(this as HTMLElement).hasAttribute("data-test-scroll")) return 0;
      return Number.parseFloat((this as HTMLElement).firstElementChild?.getAttribute("style")?.match(/height:\s*([\d.]+)/)?.[1] ?? "0") + 2;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this as HTMLElement) ?? 0; },
    set(value: number) { positions.set(this as HTMLElement, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let outline = rows();
  let resetKey = "same-run";
  let list: VirtualListState<string> | undefined;
  const render = (next: readonly Row[], nextResetKey = resetKey) => {
    outline = next;
    resetKey = nextResetKey;
    act(() => root.render(<Harness outline={outline} resetKey={resetKey} expose={(value) => { list = value; }} />));
  };
  try {
    render(outline);
    const host = container.querySelector<HTMLElement>("[data-test-scroll]")!;
    scenario.run({ host, observers, getList: () => list!, render, outline });
    const gap = host.scrollHeight - host.clientHeight - host.scrollTop;
    if (scenario.pinned) expect(gap, `${scenario.name}: pinned DOM gap`).toBeLessThanOrEqual(0.5);
    else {
      expect(gap, `${scenario.name}: unpinned route must keep its engine or anchor position`).toBeGreaterThan(2);
      expect(host.scrollTop, `${scenario.name}: DOM and engine positions must agree`).toBe(list!.snapshot.scrollTop);
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    globalThis.ResizeObserver = saved.ResizeObserver;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  }
});
