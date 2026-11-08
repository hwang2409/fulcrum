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
  const host = document.createElement("div");
  host.style.height = `${height}px`;
  document.getElementById("root")!.append(host);
  const store = createRunStore((flush) => flush());
  const root = createRoot(host);
  const mount = () => flushSync(() => root.render(h(RunProvider, { store }, h(Timeline, { renderers, virtual }))));
  mount();
  const scroller = host.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
  return { host, scroller, store, root, mount, remove: () => { root.unmount(); host.remove(); } };
}
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
  const close = () => {
    run.store.dispatch(delta(id, "```\n\nThat is the flow."));
    run.store.dispatch(commit(id, `The flow:\n\n\`\`\`mermaid\n${code}\`\`\`\n\nThat is the flow.`));
  };
  run.store.dispatch(delta(id, "The flow:\n\n```mermaid\n"));
  // "above": rows under the diagram put it above the view. tool rows: another message would end this one, and a
  // later delta would start its text again
  if (where === "above") for (let i = 0; i < 8; i++) {
    const call = { id: `after-${where}-${virtual}-${i}`, name: "bash", arguments: { command: `echo after ${i}` } };
    run.store.dispatch({ type: "tool_start", tool_call: call });
    run.store.dispatch({ type: "tool_end", tool_call: call, tool_result: { tool_call_id: call.id, content: `after ${i}\n${words(30)}`, is_error: false } });
  }
  await afterPaint();
  const { scroller } = run;
  const box = () => scroller.querySelector<HTMLElement>("[data-part=mermaid]");
  if (where === "bottom") scroller.scrollTop = scroller.scrollHeight;
  for (const line of code.split(/(?<=\n)/)) { run.store.dispatch(delta(id, line)); await afterPaint(); if (where === "bottom") scroller.scrollTop = scroller.scrollHeight; }
  await afterPaint();
  if (where !== "bottom") scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
  // a virtual timeline mounts about a screen around the view: walk down, then up, until the diagram's row is mounted
  for (const step of [1, -1]) for (let i = 0; i < 40 && !box(); i++) { scroller.scrollTop += step * scroller.clientHeight / 2; await afterPaint(); }
  // "above": the diagram's bottom 300 px above the view; "below": its top 300 px under it (both inside the render
  // margin). Measured on screen: offsetTop is a virtual row's, not the scroller's.
  const view = scroller.getBoundingClientRect();
  const move = where === "above" ? box()!.getBoundingClientRect().bottom - view.top + 300
    : where === "below" ? box()!.getBoundingClientRect().top - view.bottom - 300 : 0;
  scroller.scrollTop += move;
  await afterPaint();
  await afterPaint();
  const following = virtual && where === "bottom";
  // the reading position: the top of the first row in view that is not the diagram's
  const top = scroller.getBoundingClientRect().top;
  const anchor = following ? null : [...scroller.querySelectorAll<HTMLElement>("[data-part=message], [data-part=tool]")]
    .filter((node) => !node.contains(box()) && node.getBoundingClientRect().top >= top)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]!;
  const position = () => following ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : anchor!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const start = position();
  if (svgsIn(scroller)) throw new Error("the diagram drew before the samples started: the swap went unmeasured");
  let inserts = 0;
  const observer = new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) if (node instanceof SVGSVGElement) inserts++; });
  observer.observe(scroller, { childList: true, subtree: true });
  const heights: number[] = [];
  const positions: number[] = [];
  const stop = paintedFrames(() => {
    const current = box();
    if (current) { const height = Math.round(current.getBoundingClientRect().height * 10) / 10; if (heights.at(-1) !== height) heights.push(height); }
    positions.push(position());
  });
  const closed = performance.now();
  close();
  await until(() => svgsIn(scroller) > 0);
  const drawnMs = performance.now() - closed;
  await sleep(500);
  // later events elsewhere never draw it again
  for (let i = 0; i < 10; i++) { run.store.dispatch(delta("later", `${words(5)} `)); await afterPaint(); }
  await stop();
  observer.disconnect();
  const drift = Math.max(...positions.map((value) => Math.abs(value - start)));
  run.remove();
  // painted frames off the start position: one is a one-frame jump, all of them after the swap a lost position
  const moved = positions.filter((value) => Math.abs(value - start) > 1).length;
  const offsets = positions.map((value) => Math.round(value - start)).join(" ");
  return { virtual, where, following, drawnMs: Math.round(drawnMs), inserts, heights, drift: Math.round(drift * 10) / 10, moved, ...(moved ? { offsets } : {}), samples: positions.length };
}

/**
 * The reader's own move beats a growing row (the virtual rule: the user beats the engine). The timeline follows the
 * end, then, in one frame, a reader input moves 300 px up while the last row grows by `grow` px. `input`: "none" (no
 * move: the end must stay in view in every painted frame), "scrollbar" (a pointer drag: no input event says where),
 * "wheel", "key", "touch". After paint, every frame's scrollTop and gap to the bottom, for 12 frames.
 */
export async function race(input: "none" | "scrollbar" | "wheel" | "key" | "touch") {
  const run = mountRun(true);
  const { scroller, store } = run;
  for (let i = 0; i < 30; i++) store.dispatch(commit(`race-${i}`, `before ${i}\n\n${words(70)}`));
  const id = `race-${input}`;
  store.dispatch(delta(id, "growing"));
  for (let i = 0; i < 4; i++) { scroller.scrollTop = scroller.scrollHeight; await afterPaint(); }
  const startTop = scroller.scrollTop;
  const startGap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const row = () => [...scroller.querySelectorAll<HTMLElement>("[data-virtual-id]")].at(-1)!; // the growing message
  const rowBefore = row().getBoundingClientRect().height;
  const moved = input === "none" ? startTop : startTop - 300;
  const tops: number[] = [];
  const gaps: number[] = [];
  const stop = paintedFrames(() => { tops.push(scroller.scrollTop); gaps.push(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight); });
  await new Promise<void>((resolve) => requestAnimationFrame(() => {
    // after this frame's scroll events: the engine sees the move first in the next frame, as with a real drag
    const at = { clientX: 200, clientY: 200 };
    if (input === "scrollbar") scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, ...at }));
    if (input === "wheel") scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -300, ...at }));
    if (input === "key") scroller.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }));
    if (input === "touch") {
      const touch = (clientY: number) => new Touch({ identifier: 1, target: scroller, clientX: 200, clientY });
      scroller.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(200)] }));
      scroller.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [touch(500)] }));
    }
    scroller.scrollTop = moved;
    store.dispatch(delta(id, `\n\n${Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n\n")}`));
    resolve();
  }));
  for (let i = 0; i < 12; i++) await afterPaint();
  await stop();
  if (input === "touch") scroller.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [] }));
  if (input === "scrollbar") scroller.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  const grew = Math.round(row().getBoundingClientRect().height - rowBefore);
  run.remove();
  const off = (values: number[], want: number) => values.filter((value) => Math.abs(value - want) > 1).length;
  // the move: every painted scrollTop where the reader put it; no move: every painted gap the start's
  const wrong = input === "none" ? off(gaps, startGap) : off(tops, moved);
  return { input, grew, startTop: Math.round(startTop), moved: Math.round(moved), wrong, tops: tops.map(Math.round).join(" "), gaps: gaps.map(Math.round).join(" ") };
}

/** Calls `sample` once per painted frame, as painted, until the returned stop resolves. */
function paintedFrames(sample: () => void) {
  // a 1 px element changes width every frame, and its observer (made after the timeline's, so it runs after the
  // timeline's corrections) reads layout after this frame's resize work, before paint
  let sampling = true;
  const tick = document.body.appendChild(document.createElement("div"));
  tick.style.cssText = "position: fixed; top: 0; left: 0; height: 1px; width: 1px; visibility: hidden";
  const painted = new ResizeObserver(sample);
  painted.observe(tick);
  const sampler = (async () => {
    for (let frame = 0; sampling; frame++) { tick.style.width = `${1 + (frame & 1)}px`; await new Promise(requestAnimationFrame); }
    painted.disconnect();
    tick.remove();
  })();
  return () => { sampling = false; return sampler; };
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
  const root = createRoot(run.host);
  const started = performance.now();
  flushSync(() => root.render(h(RunProvider, { store: run.store }, h(Timeline, { renderers, virtual: false }))));
  const inFirstCommit = svgsIn(run.host) === 1;
  const cachedMs = performance.now() - started;
  root.unmount();
  run.host.remove();
  return { firstMs: Math.round(firstMs), cachedMs: Math.round(cachedMs * 10) / 10, inFirstCommit };
}

/** 50 diagrams in a plain timeline: only those near the view draw at first; scrolling to the end draws the rest. */
export async function many() {
  const run = mountRun(false, 800);
  for (let i = 0; i < 50; i++) run.store.dispatch(commit(`many-${i}`, `diagram ${i}\n\n\`\`\`mermaid\n${flow()}\`\`\`\n\n${words(40)}`));
  run.scroller.scrollTop = 0;
  await afterPaint();
  // near the view before any draw: a drawn diagram is taller than its source and pushes the others down
  const boxes = () => [...run.scroller.querySelectorAll<HTMLElement>("[data-part=mermaid]")];
  const top = run.scroller.getBoundingClientRect().top;
  const near = boxes().filter((box) => box.getBoundingClientRect().top - top < run.scroller.clientHeight + 800).length;
  await sleep(3000);
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
    const uses = [...svg.querySelectorAll("use")].map((use) => use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "");
    // dompurify drops <use> outright; were it kept, only a #fragment href may stay
    if (uses.some((href) => href && !href.startsWith("#"))) problems.push(`sanitizeSvg kept an outside use href (${uses.join(", ")})`);
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

Object.assign(window, { scenarios: { swap, race, cached, many, hostile, single } });
