import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { shimGlobal, shimProperty } from "../../../test-support/dom-shim.js";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualList, type VirtualListState } from "../src/index.js";

const SOURCE = new URL("../src/virtual.tsx", import.meta.url);

afterAll(() => GlobalRegistrator.unregister());

// Scroll writes outside writeScroll(), by file and the exact statement, each with why it is not a Timeline host write.
const OTHER_SCROLL_WRITES: Readonly<Record<string, readonly string[]>> = {
  // The text viewer's "top" control moves its own virtual list; rule (2) reads that host write as reader intent.
  "tools/text-viewer.tsx": ["node.scrollTop = 0"],
  // Non-virtual mode only (the mode-switch anchor and the approval card): the adapter is detached there (transfer(null)).
  "parts.tsx": [
    "container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - modeAnchor.current.offset",
    "card?.scrollIntoView(",
  ],
};

test("timeline scroll writes have one owner", () => {
  const message = "write timeline scroll positions only through writeScroll() in packages/react/src/virtual.tsx";
  const sourceRoot = new URL("../src/", import.meta.url);
  for (const file of readdirSync(sourceRoot, { recursive: true }).map(String).filter((name) => /\.tsx?$/.test(name))) {
    const source = readFileSync(new URL(file, sourceRoot), "utf8");
    const writes = [...source.matchAll(/[\w.\]?)]+\.(?:scrollTop\s*[-+]?=(?!=)[^;\n]*|scrollTo\s*\(|scrollBy\s*\(|scrollIntoView\s*\()/g)];
    if (file === "virtual.tsx") {
      expect(writes.map(([write]) => write), message).toEqual(["host.scrollTop = desiredHostTop"]);
      const ownerStart = source.indexOf("const writeScroll =");
      const ownerEnd = source.indexOf("\n  }, [engine, geometry, sampleOf]);", ownerStart);
      expect(writes[0]!.index! > ownerStart && writes[0]!.index! < ownerEnd, message).toBeTrue();
    } else expect(writes.map(([write]) => write), `${file}: ${message}`).toEqual([...(OTHER_SCROLL_WRITES[file] ?? [])]);
  }
});

test("timeline position owner has no cause classifier or settlement timer", () => {
  const source = readFileSync(SOURCE, "utf8");
  expect(source).toContain('const onScroll = () => settle("scroll");');
  for (const forbidden of [
    "classifyScroll", "createScrollLeases", "willScroll", "lastPointerTarget", "HostFlow",
    "quietFrames", "settleFrame", "setTimeout", "scrollend",
    "addEventListener(\"wheel\"", "addEventListener(\"keydown\"", "addEventListener(\"focusin\"",
  ]) expect(source, forbidden).not.toContain(forbidden);
  expect(source.match(/addEventListener\(\"touch(start|end|cancel)\"/g)).toHaveLength(3);
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
  return <div ref={scrollRef} data-test-scroll=""><div ref={list.timelineRef} style={{ height: list.snapshot.totalSize + 16 }}>
    {list.snapshot.rows.map((row) => <div key={row.id} ref={list.observeRow(row.id)} data-virtual-id={row.id} />)}
  </div></div>;
}

test.each(scenarios)("timeline routes $name through the DOM-aware scroll writer", (scenario) => {
  const observers: Observer[] = [];
  const positions = new WeakMap<HTMLElement, number>();
  const restores = [shimGlobal("ResizeObserver", class {
    private entry: Observer;
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, observed: new Set() }; observers.push(this.entry); }
    observe(element: Element) { this.entry.observed.add(element); }
    unobserve(element: Element) { this.entry.observed.delete(element); }
    disconnect() { this.entry.observed.clear(); }
  } as unknown as typeof ResizeObserver),
  shimGlobal("requestAnimationFrame", (callback) => (callback(0), 1)),
  shimGlobal("cancelAnimationFrame", () => {}),
  shimProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 }),
  shimProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (!(this as HTMLElement).hasAttribute("data-test-scroll")) return 0;
      return Number.parseFloat((this as HTMLElement).firstElementChild?.getAttribute("style")?.match(/height:\s*([\d.]+)/)?.[1] ?? "0");
    },
  }),
  shimProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this as HTMLElement) ?? 0; },
    set(value: number) { positions.set(this as HTMLElement, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  }),
  ];

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
      expect(host.scrollTop, `${scenario.name}: DOM and engine positions must agree`).toBe(list!.snapshot.scrollTop + 8);
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    restores.reverse().forEach((restore) => restore());
  }
});
