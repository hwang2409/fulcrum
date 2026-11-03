// The page half of mermaid-check.ts: scenarios the check runs in real chromium, each on its own mounted run.
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import "@fulcrum/mermaid/styles.css";
import "../src/fonts.css";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { Message, RunProvider, Timeline, type Renderers } from "@fulcrum/react";
import { Markdown, type MarkdownProps } from "@fulcrum/markdown/react";
import { MermaidFence } from "@fulcrum/mermaid";
import { sanitizeSvg } from "../../../packages/mermaid/src/sanitize.ts";

const fences = { mermaid: MermaidFence };
const markdown = (props: MarkdownProps) => h(Markdown, { ...props, fences });
const renderers: Renderers = { message: ({ id }) => h(Message, { id, markdown }) };
const afterPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => unknown, ms = 60_000) {
  const end = performance.now() + ms;
  while (!test()) {
    if (performance.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}
let serial = 0;
export const flow = () => {
  const n = ++serial;
  return `flowchart TD\n  A${n}[request ${n}] --> B${n}{cached?}\n  B${n} -->|yes| C${n}[serve]\n  B${n} -->|no| D${n}[render]\n  D${n} --> E${n}[(cache)]\n  E${n} --> C${n}\n`;
};
const words = (n: number) => Array.from({ length: n }, (_, i) => ["alpha", "beta", "gamma", "delta"][i % 4]).join(" ");
const commit = (id: string, text: string): RunEvent => ({ type: "message_commit", message_id: id, message: { role: "assistant", content: [{ type: "text", text }] } });
const delta = (id: string, text: string): RunEvent => ({ type: "message_delta", message_id: id, delta: text });

function mountRun(virtual: boolean, height = 600) {
  const scroller = document.createElement("div");
  scroller.style.cssText = `height: ${height}px; overflow: auto; position: relative`;
  document.getElementById("root")!.append(scroller);
  const store = createRunStore((flush) => flush());
  const root = createRoot(scroller);
  const mount = () => flushSync(() => root.render(h(RunProvider, { store }, h(Timeline, { renderers, virtual }))));
  mount();
  return { scroller, store, root, mount, remove: () => { root.unmount(); scroller.remove(); } };
}
const rows = (scroller: HTMLElement) => [...scroller.querySelectorAll<HTMLElement>("[data-part=message]")];
const svgsIn = (node: ParentNode) => node.querySelectorAll("[data-part=mermaid-diagram] > svg").length;

/**
 * One diagram message streams in line by line and closes. `where`: "bottom" (the reader is at the end), "above" (the
 * diagram sits just above the viewport when it draws), "below" (the reader scrolled up; the diagram is under the view).
 * After paint, every frame from the close until 500 ms after the diagram is in: the reading position (the gap to the
 * bottom when the timeline follows, else the top of the first row in view), the diagram box's heights, svg inserts.
 */
export async function swap(virtual: boolean, where: "bottom" | "above" | "below") {
  const run = mountRun(virtual);
  for (let i = 0; i < 12; i++) run.store.dispatch(commit(`before-${i}`, `before ${i}\n\n${words(70)}`));
  const id = `diagram-${where}-${virtual}`;
  const code = flow();
  run.store.dispatch(delta(id, "The flow:\n\n```mermaid\n"));
  if (where === "above") for (let i = 0; i < 6; i++) run.store.dispatch(commit(`after-${i}`, `after ${i}\n\n${words(70)}`));
  await afterPaint();
  const { scroller } = run;
  const box = () => scroller.querySelector<HTMLElement>("[data-part=mermaid]");
  if (where === "bottom") scroller.scrollTop = scroller.scrollHeight;
  for (const line of code.split(/(?<=\n)/)) { run.store.dispatch(delta(id, line)); await afterPaint(); if (where === "bottom") scroller.scrollTop = scroller.scrollHeight; }
  await afterPaint();
  if (where === "above") {
    // the diagram's bottom 300 px above the viewport: inside the render margin, out of view
    const rect = box()!.getBoundingClientRect();
    scroller.scrollTop += rect.bottom - scroller.getBoundingClientRect().top + 300;
  }
  if (where === "below") scroller.scrollTop = Math.max(0, box()!.offsetTop - scroller.clientHeight - 300);
  await afterPaint();
  await afterPaint();
  const following = virtual && where === "bottom";
  const anchor = following ? null : rows(scroller).find((row) => !row.contains(box()) && row.getBoundingClientRect().top >= scroller.getBoundingClientRect().top)!;
  const position = () => following ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : anchor!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const start = position();
  let inserts = 0;
  const observer = new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) if (node instanceof SVGSVGElement) inserts++; });
  observer.observe(scroller, { childList: true, subtree: true });
  const heights: number[] = [];
  const positions: number[] = [];
  let sampling = true;
  const sample = async () => {
    while (sampling) {
      await afterPaint();
      const current = box();
      if (current) { const height = Math.round(current.getBoundingClientRect().height * 10) / 10; if (heights.at(-1) !== height) heights.push(height); }
      positions.push(position());
    }
  };
  const sampler = sample();
  const closed = performance.now();
  run.store.dispatch(delta(id, "```\n\nThat is the flow."));
  run.store.dispatch(commit(id, `The flow:\n\n\`\`\`mermaid\n${code}\`\`\`\n\nThat is the flow.`));
  await until(() => svgsIn(scroller) > 0);
  const drawnMs = performance.now() - closed;
  await sleep(500);
  // later events elsewhere never draw it again
  for (let i = 0; i < 10; i++) { run.store.dispatch(delta("later", `${words(5)} `)); await afterPaint(); }
  sampling = false;
  await sampler;
  observer.disconnect();
  const drift = Math.max(...positions.map((value) => Math.abs(value - start)));
  run.remove();
  return { virtual, where, following, drawnMs: Math.round(drawnMs), inserts, heights, drift: Math.round(drift * 10) / 10, samples: positions.length };
}

/** A diagram drawn once shows from the cache in the commit that mounts it again: no source frame, no render. */
export async function cached() {
  const run = mountRun(false);
  const code = flow();
  run.store.dispatch(commit("cached", `\`\`\`mermaid\n${code}\`\`\`\n`));
  const closed = performance.now();
  await until(() => svgsIn(run.scroller) > 0);
  const firstMs = performance.now() - closed;
  run.root.unmount();
  const root = createRoot(run.scroller);
  const started = performance.now();
  flushSync(() => root.render(h(RunProvider, { store: run.store }, h(Timeline, { renderers, virtual: false }))));
  const inFirstCommit = svgsIn(run.scroller) === 1;
  const cachedMs = performance.now() - started;
  root.unmount();
  run.scroller.remove();
  return { firstMs: Math.round(firstMs), cachedMs: Math.round(cachedMs * 10) / 10, inFirstCommit };
}

/** 50 diagrams in a plain timeline: only those near the view draw at first; scrolling to the end draws the rest. */
export async function many() {
  const run = mountRun(false, 800);
  for (let i = 0; i < 50; i++) run.store.dispatch(commit(`many-${i}`, `diagram ${i}\n\n\`\`\`mermaid\n${flow()}\`\`\`\n\n${words(40)}`));
  run.scroller.scrollTop = 0;
  await sleep(3000);
  const boxes = () => [...run.scroller.querySelectorAll<HTMLElement>("[data-part=mermaid]")];
  const top = run.scroller.getBoundingClientRect().top;
  const near = boxes().filter((box) => box.getBoundingClientRect().top - top < run.scroller.clientHeight + 800).length;
  const drawnAtStart = svgsIn(run.scroller);
  const tasks: number[] = [];
  const longTasks = new PerformanceObserver((list) => tasks.push(...list.getEntries().map((entry) => entry.duration)));
  longTasks.observe({ type: "longtask" });
  let frames = 0, worstFrame = 0, last = performance.now();
  const scrolled = performance.now();
  while (run.scroller.scrollTop + run.scroller.clientHeight < run.scroller.scrollHeight - 1) {
    run.scroller.scrollTop += 400;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = performance.now();
    worstFrame = Math.max(worstFrame, now - last);
    last = now;
    frames++;
  }
  await until(() => svgsIn(run.scroller) === 50, 120_000);
  const allMs = performance.now() - scrolled;
  longTasks.disconnect();
  run.remove();
  tasks.sort((a, b) => a - b);
  return { total: 50, near, drawnAtStart, scrollFrames: frames, worstScrollFrameMs: Math.round(worstFrame), allDrawnMs: Math.round(allMs), longTasks: tasks.length, medianLongTaskMs: Math.round(tasks[tasks.length >> 1] ?? 0), maxLongTaskMs: Math.round(tasks.at(-1) ?? 0) };
}

/** Diagrams that try to get html, script, links, or outside urls into the page, through the real mermaid. */
export async function hostile() {
  const sources = [
    '%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}, "themeCSS": "svg { background: url(https://evil.example/bg.png) }"}}%%\nflowchart TD\n  A["<img src=x onerror=window.__pwned=1>"] --> B\n  click A call window.__pwnedCall()\n  click B "javascript:window.__pwned=2" "tip"\n',
    "flowchart TD\n  A --> B\n  classDef evil fill:url(https://evil.example/fill.png),stroke:#f00\n  class A evil\n  style B fill:url(https://evil.example/style.png)\n",
    "sequenceDiagram\n  link Alice: home @ javascript:window.__pwned=3\n  Alice->>Bob: <script>window.__pwned=4</script>\n",
    "---\nconfig:\n  securityLevel: loose\n  htmlLabels: true\n---\nclassDiagram\n  class A {\n    +<img src=x onerror=window.__pwned=5>\n  }\n  click A href \"javascript:window.__pwned=6\"\n",
  ];
  const host = document.createElement("div");
  document.getElementById("root")!.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(h("div", null, sources.map((source, index) => h(Markdown, { key: index, id: `hostile-${index}`, source: `\`\`\`mermaid\n${source}\`\`\`\n`, fences })))));
  await until(() => [...host.querySelectorAll("[data-part=mermaid]")].every((box) => box.getAttribute("data-state") !== "pending"));
  await sleep(200);
  host.querySelectorAll("svg *").forEach((node) => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await sleep(200);
  const markup = [...host.querySelectorAll("svg")].map((svg) => svg.outerHTML).join("\n");
  const problems = [
    ...["<foreignobject", "<a ", "<script", "<img", "<image", "onerror", "onclick", "onload", "javascript:", "evil.example"].filter((bad) => markup.toLowerCase().includes(bad)),
    ...("__pwned" in window ? [`__pwned=${(window as unknown as { __pwned: number }).__pwned}`] : []),
    ...(document.querySelector("[id^=dfulcrum-mermaid], [id^=ifulcrum-mermaid]") ? ["mermaid left a measuring element in the page"] : []),
  ];
  const states = [...host.querySelectorAll("[data-part=mermaid]")].map((box) => box.getAttribute("data-state"));
  // sanitizeSvg directly, on markup mermaid itself would never emit
  const svg = sanitizeSvg(`<svg id="m1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300.5 120" width="100%" style="max-width: 300px;" onload="window.__pwned=7">
    <style>#m1 .node rect { fill: #fff; }</style><style>@import url(https://evil.example/x.css);</style><script>window.__pwned=8</script>
    <defs><marker id="m1_arrow"><path d="M0 0"/></marker></defs>
    <g class="node" onclick="window.__pwned=9"><rect width="10" height="10" style="fill: url(https://evil.example/p.png)"/></g>
    <path marker-end="url(#m1_arrow)" d="M0 0L1 1"/><a href="javascript:window.__pwned=10"><text>link text</text></a>
    <foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.__pwned=11"/></div></foreignObject>
    <image href="https://evil.example/pixel.png"/><use href="#m1_arrow"/><use href="https://evil.example/sprite.svg#a"/></svg>`);
  const direct = svg?.outerHTML ?? "";
  if (!svg) problems.push("sanitizeSvg dropped a valid svg");
  else {
    problems.push(...["onload", "onclick", "onerror", "<script", "javascript:", "foreignObject", "<img", "<image", "evil.example", "@import"].filter((bad) => direct.includes(bad)).map((bad) => `sanitizeSvg kept ${bad}`));
    if (svg.querySelectorAll("style").length !== 1) problems.push("sanitizeSvg: the safe style should stay, the @import one go");
    if (svg.querySelector("path[marker-end]")?.getAttribute("marker-end") !== "url(#m1_arrow)") problems.push("sanitizeSvg dropped an internal marker reference");
    if (svg.querySelector("text")?.textContent !== "link text") problems.push("sanitizeSvg dropped a link's text");
    if ([...svg.querySelectorAll("use")].map((use) => use.getAttribute("href")).join() !== "#m1_arrow,") problems.push("sanitizeSvg: only #fragment use hrefs stay");
    if ([svg.getAttribute("width"), svg.getAttribute("height"), svg.style.maxWidth].join() !== "301,120,") problems.push("sanitizeSvg: the svg should take its viewBox size");
  }
  if (sanitizeSvg("<div>no svg</div>") || sanitizeSvg("<script>1</script>")) problems.push("sanitizeSvg returned an svg for markup with none");
  root.unmount();
  host.remove();
  return { states, problems };
}

/** One diagram, for the keyboard, width, and theme checks the check drives from outside. */
export async function single() {
  const host = document.createElement("div");
  host.id = "single";
  host.style.cssText = "max-width: 720px; padding: 0 16px";
  document.getElementById("root")!.append(host);
  createRoot(host).render(h(Markdown, { id: "single", source: "Wide:\n\n```mermaid\nflowchart LR\n  A[a long first step] --> B[a long second step] --> C[a long third step] --> D[a long fourth step] --> E[done]\n```\n\nafter", fences }));
  await until(() => svgsIn(host) === 1);
}

Object.assign(window, { scenarios: { swap, cached, many, hostile, single } });
