import { useLayoutEffect, useRef, useState } from "react";
import type { FenceProps } from "@fulcrum/markdown/react";
import { CopyButton } from "@fulcrum/react/code";
import type { Rendered } from "./render.js";
import { themeKey } from "./theme.js";

// Rendered diagrams by theme and source, least recently used first: a diagram that scrolls back in, remounts, or
// returns to a theme it had shows at once, with no second render.
const CACHE_SIZE = 128;
const cache = new Map<string, Rendered>();
const remember = (key: string, rendered: Rendered) => {
  cache.delete(key);
  cache.set(key, rendered);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
};
const recall = (key: string) => {
  const hit = cache.get(key);
  if (hit) remember(key, hit);
  return hit;
};

// Fences that want each key now, so a render runs at most once per key and only while one of them is still mounted.
const wanted = new Map<string, Set<Element>>();
const running = new Map<string, Promise<Rendered | null>>();
let queue: Promise<unknown> = Promise.resolve();
let renderer: Promise<typeof import("./render.js")> | undefined;
const RENDER_TIMEOUT_MS = 20_000;
declare global { var __FULCRUM_DEV__: boolean | undefined; }
const viteDevelopment = typeof (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env === "object"
  ? (import.meta as ImportMeta & { env: { DEV?: boolean } }).env.DEV
  : undefined;
const development = globalThis.__FULCRUM_DEV__ === undefined ? viteDevelopment !== false : globalThis.__FULCRUM_DEV__;
const reportFailure = development
  ? (error: unknown) => console.error("Mermaid could not render a diagram.", error)
  : () => {};
const fallback = (error: unknown): Rendered => {
  reportFailure(error);
  return { error: error instanceof Error && error.message === "render timed out" ? error.message : "the diagram could not be drawn" };
};
// After paint and while the page is idle (a timeout keeps a busy stream from starving it), one diagram at a time:
// mermaid's render is one task that cannot be split, and it shares global config.
const idle = () => new Promise<void>((resolve) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 500 });
  else setTimeout(resolve, 16);
});

async function renderResult(key: string, code: string): Promise<Rendered | null> {
  await idle();
  const host = [...wanted.get(key) ?? []].find((element) => element.isConnected);
  if (!host) return null; // every fence that asked has gone (scrolled out of a virtual list): it asks again later
  const module = await (renderer ??= import("./render.js").catch((error) => { renderer = undefined; throw error; }));
  return module.renderMermaid(code, host);
}

function withRenderDeadline(render: Promise<Rendered | null>) {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("render timed out")), RENDER_TIMEOUT_MS); });
  return Promise.race([render, deadline]).finally(() => clearTimeout(timer));
}

function request(key: string, code: string): Promise<Rendered | null> {
  let job = running.get(key);
  if (job) return job;
  const render = queue.then(() => renderResult(key, code));
  queue = render.catch(() => null); // a timed-out mermaid call keeps this queue slot until its uncancellable promise settles
  job = withRenderDeadline(render).then((rendered) => {
    if (!rendered) return null;
    if ("error" in rendered) reportFailure(new Error(rendered.error));
    remember(key, rendered);
    return rendered;
  }, (error) => {
    const rendered = fallback(error);
    remember(key, rendered);
    return rendered;
  }).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

// One watcher for every fence: `data-fulcrum-theme` anywhere, a class or style on <html> or <body> (where apps put a
// theme class or token overrides), or the OS color scheme that themes.css follows. Fences re-read once per frame.
const themeListeners = new Set<() => void>();
let stopWatching: (() => void) | undefined;
function watchTheme(listener: () => void) {
  themeListeners.add(listener);
  if (!stopWatching && typeof MutationObserver === "function") {
    let frame = 0;
    const changed = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => themeListeners.forEach((each) => each())); };
    const themes = new MutationObserver(changed);
    themes.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["data-fulcrum-theme"] });
    const page = new MutationObserver(changed);
    for (const node of [document.documentElement, document.body]) page.observe(node, { attributes: true, attributeFilter: ["class", "style"] });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", changed);
    stopWatching = () => { themes.disconnect(); page.disconnect(); scheme.removeEventListener("change", changed); cancelAnimationFrame(frame); stopWatching = undefined; };
  }
  return () => {
    themeListeners.delete(listener);
    if (!themeListeners.size) stopWatching?.();
  };
}

// Calls `near` once the box is within about a screen of the viewport (or of the scroller that clips it).
function whenNear(box: Element, near: () => void) {
  if (typeof IntersectionObserver !== "function") { near(); return () => {}; }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    near();
  }, { rootMargin: "800px 0px", scrollMargin: "800px 0px" } as IntersectionObserverInit);
  observer.observe(box);
  return () => observer.disconnect();
}

// Each mounted diagram is its own copy with its own ids, so two copies of one diagram never share markers or styles.
let copies = 0;
function copyOf(svg: SVGSVGElement): SVGSVGElement {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const from = svg.id;
  if (!from) return copy;
  const to = `${from}-${++copies}`;
  for (const element of [copy, ...copy.querySelectorAll("*")]) {
    for (const attribute of element.attributes) if (attribute.value.includes(from)) attribute.value = attribute.value.split(from).join(to);
    if (element.localName === "style") element.textContent = element.textContent!.split(from).join(to);
  }
  return copy;
}

// The smallest label a diagram is scaled down to, in px. Under it, the diagram keeps that scale and scrolls.
const READABLE_PX = 11;
// Each drawn diagram's smallest label size, read from its first mounted copy (getComputedStyle needs it in the page).
const smallestLabel = new WeakMap<SVGSVGElement, number>();
function smallestText(svg: SVGSVGElement) {
  let least = Infinity;
  for (const text of svg.querySelectorAll("text")) if (text.textContent?.trim()) least = Math.min(least, parseFloat(getComputedStyle(text).fontSize) || Infinity);
  return least;
}

/** The scale that fits `natural` px into `room` px, never under the one that keeps a `smallest` px label readable, never up. */
function fitScale(room: number, natural: number, smallest: number): number {
  return Math.min(1, Math.max(room / natural, READABLE_PX / smallest));
}

/**
 * The drawn diagram. `fit`: scaled down to its box while its smallest label stays readable; wider than that, it
 * scrolls inside the box, which is then a labelled, focusable group with an edge fade on each side with more to see.
 * Without `fit` (full size), it is its natural size. Recomputed when the box resizes.
 */
function Svg({ svg, part, fit = false, onFailure }: { svg: SVGSVGElement; part: string; fit?: boolean; onFailure?: (error: unknown) => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Before paint, in the commit that shows it: the box goes from the source to the diagram, at its scale, in one layout.
  useLayoutEffect(() => {
    const node = box.current!;
    let copy: SVGSVGElement;
    try {
      copy = copyOf(svg);
      node.replaceChildren(copy);
    } catch (error) {
      onFailure?.(error);
      return;
    }
    const width = Number(svg.getAttribute("width"));
    const height = Number(svg.getAttribute("height"));
    const edges = () => {
      const end = node.scrollWidth - node.clientWidth - node.scrollLeft;
      frame.current!.dataset.overflow = `${node.scrollLeft > 1 ? "start " : ""}${end > 1 ? "end" : ""}`.trim();
      if (node.scrollWidth > node.clientWidth + 1) {
        node.tabIndex = 0;
        node.setAttribute("role", "group"); // not a region landmark: a transcript can hold many diagrams
        node.setAttribute("aria-label", `${copy.getAttribute("aria-label") ?? "diagram"}, scrolls sideways`);
      } else {
        node.removeAttribute("tabindex");
        node.removeAttribute("role");
        node.removeAttribute("aria-label");
      }
    };
    const size = () => {
      if (fit && width > 0 && height > 0) {
        const style = getComputedStyle(node);
        const room = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        let least = smallestLabel.get(svg);
        if (least === undefined) smallestLabel.set(svg, least = smallestText(copy));
        const scale = fitScale(room, width, least);
        copy.setAttribute("width", String(Math.floor(width * scale * 100) / 100));
        copy.setAttribute("height", String(Math.floor(height * scale * 100) / 100));
      }
      edges();
    };
    size();
    const resized = new ResizeObserver(size);
    resized.observe(node);
    node.addEventListener("scroll", edges, { passive: true });
    return () => {
      resized.disconnect();
      node.removeEventListener("scroll", edges);
      node.replaceChildren();
    };
  }, [svg, fit]);
  return <div ref={frame} data-part={`${part}-frame`}><div ref={box} data-part={part} /></div>;
}

function FullSize({ svg, label, onClose }: { svg: SVGSVGElement; label: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dialog.current!.showModal();
  }, []);
  return (
    <dialog ref={dialog} data-part="mermaid-dialog" aria-label={label} onClose={onClose}>
      <div data-part="mermaid-bar">
        <span data-part="mermaid-caption">{label}</span>
        <button type="button" data-action="close" aria-label="close full size diagram" onClick={() => dialog.current!.close()}>close</button>
      </div>
      <Svg svg={svg} part="mermaid-full" />
    </dialog>
  );
}

/**
 * A mermaid fence for `@fulcrum/markdown` (`fences={{ mermaid: MermaidFence }}`). While the fence streams, and until its
 * diagram is ready, it is the highlighted source, unchanged. Once the fence closes and is near the viewport, mermaid
 * loads (on the first diagram of the page), draws it at idle time, and the box switches to the diagram in one layout,
 * with controls for the diagram or its source, copy, and full size. An invalid diagram stays source with a short error.
 */
export function MermaidFence({ code, done, source }: FenceProps) {
  const box = useRef<HTMLDivElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useState<string>();
  const [result, setResult] = useState<{ code: string; rendered: Rendered }>();
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const [full, setFull] = useState(false);
  const reportedApplyFailure = useRef<string | undefined>(undefined);
  const key = done && theme !== undefined ? `${theme}\n${code}` : undefined;
  const applyFailed = (error: unknown) => {
    if (reportedApplyFailure.current !== key) {
      reportedApplyFailure.current = key;
      const hit = key ? recall(key) : undefined;
      const rendered = hit && "error" in hit ? hit : fallback(error);
      if (key) remember(key, rendered);
      setResult({ code, rendered });
    }
  };

  useLayoutEffect(() => {
    if (!done) return;
    const read = () => setTheme(themeKey(box.current!));
    read();
    return watchTheme(read);
  }, [done]);

  // A cached diagram is set here, before the first paint: it never shows its source first.
  useLayoutEffect(() => {
    if (!key) return;
    const hit = recall(key);
    if (hit) { setResult({ code, rendered: hit }); return; }
    const element = box.current!;
    let live = true;
    const stop = whenNear(element, () => {
      const set = wanted.get(key) ?? new Set();
      wanted.set(key, set.add(element));
      void request(key, code).then((rendered) => { if (live && rendered) setResult({ code, rendered }); });
    });
    return () => {
      live = false;
      stop();
      const set = wanted.get(key);
      set?.delete(element);
      if (set?.size === 0) wanted.delete(key);
    };
  }, [key]);

  // An older theme's diagram stays up while the new one draws; another source's never shows.
  const shown = done && result?.code === code ? result.rendered : undefined;
  const diagram = shown && "svg" in shown ? shown : undefined;
  const showDiagram = !!diagram && view === "diagram";
  const state = !done ? "streaming" : diagram ? view : shown ? "error" : "pending";
  return (
    <div ref={box} data-part="mermaid" data-state={state} data-mermaid-fallback={state === "error" ? "" : undefined} data-wide="">
      {diagram ? (
        <div data-part="mermaid-bar">
          <span data-part="mermaid-caption">mermaid</span>
          <span data-part="mermaid-views" role="group" aria-label="show">
            <button type="button" data-action="diagram" aria-pressed={view === "diagram"} onClick={() => setView("diagram")}>diagram</button>
            <button type="button" data-action="source" aria-pressed={view === "source"} onClick={() => setView("source")}>source</button>
          </span>
          <CopyButton label="source" value={code} />
          <button ref={openButton} type="button" data-action="open" aria-haspopup="dialog" aria-label="open diagram full size" onClick={() => setFull(true)}>open</button>
        </div>
      ) : null}
      {showDiagram ? <Svg svg={diagram.svg} part="mermaid-diagram" fit onFailure={applyFailed} /> : null}
      <div data-part="mermaid-source" hidden={showDiagram}>{source}</div>
      {shown && "error" in shown ? <p data-part="mermaid-error" role="note">mermaid: {shown.error}</p> : null}
      {full && diagram ? <FullSize svg={diagram.svg} label={diagram.label} onClose={() => { setFull(false); openButton.current?.focus(); }} /> : null}
    </div>
  );
}
