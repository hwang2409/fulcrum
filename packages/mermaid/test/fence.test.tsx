import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { domShimAlarm, shimGlobal } from "../../../test-support/dom-shim.js";
let restoreObserver: (() => void) | undefined;
afterAll(() => restoreObserver?.());
domShimAlarm(import.meta.path);

type Rendered = { svg: SVGSVGElement; label: string } | { error: string };
const calls: Array<{ code: string; host: Element }> = [];
let answer: (code: string) => Rendered;
const svgFor = (code: string) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = `fake-${calls.length}`;
  svg.setAttribute("aria-label", `diagram of ${code.trim()}`);
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.id = `${svg.id}_arrow`;
  svg.append(marker);
  return svg as SVGSVGElement;
};
// The lazy module: counts loads and renders; mermaid itself is checked in a real browser (apps/playground mermaid-check).
let loads = 0;
mock.module("../src/render.ts", () => {
  loads++;
  return { renderMermaid: async (code: string, host: Element) => { calls.push({ code, host }); return answer(code); } };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Markdown } = await import("@fulcrum/markdown/react");
const { MermaidFence } = await import("../src/index.tsx");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterAll(() => GlobalRegistrator.unregister());

// Every box is in view at once (happy-dom has no layout), and idle comes after a macrotask.
const observed: Element[] = [];
restoreObserver = shimGlobal("IntersectionObserver", class {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) { observed.push(target); queueMicrotask(() => this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
} as unknown as typeof IntersectionObserver);

const fences = { mermaid: MermaidFence };
const settle = async () => { for (let i = 0; i < 6; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 20))); };
// Themes as themes.css sets them (happy-dom does not inherit custom properties, so the rules target the box).
const themes = document.createElement("style");
themes.textContent = '[data-part="mermaid"] { --fulcrum-accent: #0969da; } [data-fulcrum-theme="dracula"] [data-part="mermaid"] { --fulcrum-accent: #ff79c6; }';
document.head.append(themes);
function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (source: string, streaming = false) => act(() => root.render(<Markdown id="m" source={source} streaming={streaming} fences={fences} />));
  return { host, render, unmount: async () => { await act(() => root.unmount()); host.remove(); } };
}
const fence = (code: string) => "intro\n\n```mermaid\n" + code + "```\n";
let n = 0;
const fresh = () => `graph TD\nA${++n}-->B\n`; // a source no earlier test cached

beforeEach(() => {
  calls.length = 0;
  answer = (code) => ({ svg: svgFor(code), label: `diagram of ${code.trim()}` });
});

test("an open fence is today's highlighted source, and mermaid is not loaded for it", async () => {
  const { host, render, unmount } = mount();
  await render("intro\n\n```mermaid\ngraph TD\nA-->", true);
  await settle();
  expect(host.querySelector("[data-part=mermaid]")?.getAttribute("data-state")).toBe("streaming");
  expect(host.querySelector("[data-part=mermaid-source] pre[data-part=md-code-block]")?.textContent).toBe("graph TD\nA-->");
  expect(host.querySelector("[data-part=mermaid-bar]")).toBeNull();
  expect(loads).toBe(0);
  expect(calls).toHaveLength(0);
  await unmount();
});

test("a closed fence draws once and switches to the diagram, with labeled controls", async () => {
  const code = fresh();
  const { host, render, unmount } = mount();
  let source = "intro\n\n```mermaid\n";
  for (const line of code.split(/(?<=\n)/)) {
    source += line;
    await render(source, true);
  }
  await settle();
  expect(calls).toHaveLength(0); // never per token
  source += "```\n\nafter";
  await render(source, true);
  for (const word of [" one", " two"]) await render((source += word), true);
  await settle();
  expect(calls.map((call) => call.code)).toEqual([code]);
  expect(loads).toBe(1);
  const box = host.querySelector("[data-part=mermaid]")!;
  expect(box.getAttribute("data-state")).toBe("diagram");
  const svg = box.querySelector("[data-part=mermaid-diagram] > svg")!;
  expect(svg.getAttribute("aria-label")).toBe(`diagram of ${code.trim()}`);
  expect((box.querySelector("[data-part=mermaid-source]") as HTMLElement).hidden).toBe(true);
  const button = (name: string) => box.querySelector<HTMLButtonElement>(`[data-part=mermaid-bar] button[data-action=${name}]`)!;
  expect(button("diagram").getAttribute("aria-pressed")).toBe("true");
  expect(button("copy").getAttribute("aria-label")).toBe("copy source");
  expect(button("open").getAttribute("aria-label")).toBe("open diagram full size");
  await act(() => button("source").click());
  expect(box.getAttribute("data-state")).toBe("source");
  expect(box.querySelector("[data-part=mermaid-diagram]")).toBeNull();
  expect((box.querySelector("[data-part=mermaid-source]") as HTMLElement).hidden).toBe(false);
  expect(button("source").getAttribute("aria-pressed")).toBe("true");
  await act(() => button("diagram").click());
  expect(box.querySelector("[data-part=mermaid-diagram] > svg")).not.toBeNull();
  expect(calls).toHaveLength(1);
  await unmount();
});

test("a drawn diagram shows from the cache in the first commit when it mounts again", async () => {
  const code = fresh();
  const first = mount();
  await first.render(fence(code));
  await settle();
  expect(calls).toHaveLength(1);
  await first.unmount();
  const again = mount();
  await again.render(fence(code));
  // no settle: the layout effect set it before this act returned
  expect(again.host.querySelector("[data-part=mermaid]")?.getAttribute("data-state")).toBe("diagram");
  await settle();
  expect(calls).toHaveLength(1);
  await again.unmount();
});

test("every copy has its own ids, so two copies of one diagram never share markers", async () => {
  const code = fresh();
  const a = mount();
  const b = mount();
  await a.render(fence(code));
  await b.render(fence(code));
  await settle();
  expect(calls).toHaveLength(1); // one render serves both fences
  const ids = [a.host, b.host].map((host) => host.querySelector("[data-part=mermaid-diagram] > svg")!.id);
  expect(new Set(ids).size).toBe(2);
  for (const [index, host] of [a.host, b.host].entries()) expect(host.querySelector("marker")!.id).toBe(`${ids[index]}_arrow`);
  await a.unmount();
  await b.unmount();
});

test("an invalid diagram keeps its source with a short error, and never a blank box", async () => {
  answer = () => ({ error: "Parse error on line 2: Expecting 'SQE', got 'PS'" });
  const { host, render, unmount } = mount();
  await render(fence("graph TD\nA[oops(\n"));
  await settle();
  const box = host.querySelector("[data-part=mermaid]")!;
  expect(box.getAttribute("data-state")).toBe("error");
  expect((box.querySelector("[data-part=mermaid-source]") as HTMLElement).hidden).toBe(false);
  expect(box.querySelector("[data-part=mermaid-source] pre")?.textContent).toBe("graph TD\nA[oops(\n");
  expect(box.querySelector("[data-part=mermaid-error]")?.textContent).toBe("mermaid: Parse error on line 2: Expecting 'SQE', got 'PS'");
  expect(box.querySelector("[data-part=mermaid-bar]")).toBeNull();
  expect(host.querySelector("p")?.textContent).toBe("intro"); // the rest of the message is there
  await unmount();
});

test("a theme change draws again in the new colors; the old diagram stays up meanwhile", async () => {
  const code = fresh();
  const { host, render, unmount } = mount();
  await render(fence(code));
  await settle();
  expect(calls).toHaveLength(1);
  const before = host.querySelector("[data-part=mermaid-diagram] > svg");
  await act(() => host.setAttribute("data-fulcrum-theme", "dracula"));
  await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  // the new theme's render has not run yet: the old diagram is still up, not the source
  expect(host.querySelector("[data-part=mermaid-diagram] > svg")).toBe(before);
  await settle();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.host).toBe(host.querySelector("[data-part=mermaid]")!);
  expect(host.querySelector("[data-part=mermaid-diagram] > svg")).not.toBe(before);
  // and back: the first theme's diagram comes from the cache
  await act(() => host.removeAttribute("data-fulcrum-theme"));
  await settle();
  expect(calls).toHaveLength(2);
  await unmount();
});

test("a fence that leaves before its turn is not drawn", async () => {
  const code = fresh();
  const { render, unmount } = mount();
  await render(fence(code));
  await unmount();
  await settle();
  expect(calls).toHaveLength(0);
});

test("a crowded gantt axis keeps every nth date and every grid line", async () => {
  const { thinAxis } = await import("../src/sanitize.ts");
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg") as SVGSVGElement;
  const axis = svg.appendChild(document.createElementNS(ns, "g"));
  axis.setAttribute("class", "grid");
  axis.setAttribute("font-size", "10");
  for (let i = 0; i < 19; i++) {
    const tick = axis.appendChild(document.createElementNS(ns, "g"));
    tick.setAttribute("class", "tick");
    tick.setAttribute("transform", `translate(${i * 27},0)`);
    tick.append(document.createElementNS(ns, "line"), Object.assign(document.createElementNS(ns, "text"), { textContent: "10-01" }));
  }
  thinAxis(svg);
  // 5 characters at 6 px plus a 10 px gap need 40 px: every 2nd of the 27 px ticks
  expect(svg.querySelectorAll(".tick text").length).toBe(10);
  expect(svg.querySelectorAll(".tick line").length).toBe(19);
  axis.setAttribute("font-size", "1");
  const before = svg.querySelectorAll(".tick text").length;
  thinAxis(svg); // labels that fit stay
  expect(svg.querySelectorAll(".tick text").length).toBe(before);
});
