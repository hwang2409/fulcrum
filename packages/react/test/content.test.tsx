import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { domShimAlarm, shimGlobal, shimProperty } from "../../../test-support/dom-shim.js";
domShimAlarm(import.meta.path);
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, MAX_URL_CHARS, type ContentBlock, type RunEvent } from "@fulcrum/core";
import { Markdown } from "../../markdown/src/react.js";
import { Message, RunProvider, ToolCall, type BlockRenderers, type ContentBlockProps, type LoadMedia } from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());

function setup(events: RunEvent[]) {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const send = (...more: RunEvent[]) =>
    act(() => {
      more.forEach(store.dispatch);
      jobs.splice(0).forEach((job) => job());
    });
  events.forEach(store.dispatch);
  jobs.splice(0).forEach((job) => job());
  return { store, send };
}

let root: Root | undefined;
let container: HTMLElement;
const restoreShims: Array<() => void> = [];
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  restoreShims.splice(0).reverse().forEach((restore) => restore());
});
function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}
const q = (selector: string) => container.querySelector(selector) as HTMLElement;
// The message's direct block parts, in DOM order (markdown text shows as its md-* parts).
const order = () => [...q('[data-part="message-content"]')?.children ?? q('[data-part="message"]').children].map((child) => (child as HTMLElement).dataset.part).filter((part) => part !== "reasoning-live");
const commit = (content: ContentBlock[], role = "assistant"): RunEvent => ({ type: "message_commit", message_id: "m", message: { role, content } });
const render = (events: RunEvent[], props: { blocks?: BlockRenderers; onOpen?: ContentBlockProps["onOpen"]; markdown?: boolean; loadMedia?: LoadMedia } = {}) => {
  const setupResult = setup(events);
  mount(<RunProvider store={setupResult.store} loadMedia={props.loadMedia}><Message id="message:m" markdown={props.markdown === false ? false : Markdown} blocks={props.blocks} onOpen={props.onOpen} /></RunProvider>);
  return setupResult;
};

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("a user message keeps its decorative prompt separate from its content", () => {
  render([commit([{ type: "text", text: "hello\nthere" }], "user")]);
  expect(q('[data-part="message-prompt"]').getAttribute("aria-hidden")).toBe("true");
  expect(q('[data-part="message-prompt"]').textContent).toBe("> ");
  expect(q('[data-part="message-content"]').textContent).toBe("hello\nthere");
  expect(q('[data-part="message-content"]').style.whiteSpace).toBe("pre-wrap");
});

test("plain assistant text keeps the prior direct text-node DOM", () => {
  render([commit([{ type: "text", text: "hello" }])], { markdown: false });
  const message = q('[data-part="message"]');
  expect(message.childNodes).toHaveLength(1);
  expect(message.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  expect(message.innerHTML).toBe("hello");
});

test("plain assistant text beside blocks has its own span, so the streaming cursor can end it", () => {
  render([{ type: "message_delta", message_id: "m", kind: "reasoning", delta: "let me check" }, { type: "message_delta", message_id: "m", delta: "the answer" }], { markdown: false });
  const last = q('[data-part="message"]').lastChild as HTMLElement;
  expect(last.tagName).toBe("SPAN");
  expect(last.dataset.part).toBeUndefined();
  expect(last.textContent).toBe("the answer");
});

test("streaming plain text hides its trailing whitespace like markdown, so the cursor hugs the last word; the commit keeps it", () => {
  const { send } = render([{ type: "message_delta", message_id: "m", delta: "the answer " }], { markdown: false });
  expect(q('[data-part="message"]').textContent).toBe("the answer");
  send({ type: "message_delta", message_id: "m", delta: "is\n" });
  expect(q('[data-part="message"]').textContent).toBe("the answer is");
  send(commit([{ type: "text", text: "the answer is\n" }]));
  expect(q('[data-part="message"]').textContent).toBe("the answer is\n");
});

test("streaming plain text that ends in a blank line keeps the line the commit shows, without trailing tabs or spaces", () => {
  const { send } = render([{ type: "message_delta", message_id: "m", delta: "tabbed\t" }], { markdown: false });
  expect(q('[data-part="message"]').textContent).toBe("tabbed");
  send({ type: "message_delta", message_id: "m", delta: "end \n\n" });
  // One line break less: the cursor (styles.css) sits on the blank line, where it takes the commit's height.
  expect(q('[data-part="message"]').textContent).toBe("tabbed\tend \n");
  send(commit([{ type: "text", text: "tabbed\tend \n\n" }]));
  expect(q('[data-part="message"]').textContent).toBe("tabbed\tend \n\n");
});

test("empty text does not precede the first rendered content block", () => {
  render([commit([{ type: "text", text: "" }, { type: "file", kind: "file", filename: "a.png" }], "user")]);
  expect(q('[data-part="message-content"]').firstElementChild?.getAttribute("data-part")).toBe("file");
});

test("truncated history strings stay visible in markdown and tool cards", () => {
  const truncated = "[truncated: original utf-8 bytes=1048577]";
  const call = { id: "truncated", name: "bash", arguments: { command: "printf output" } };
  const { store } = setup([
    commit([{ type: "text", text: `unfinished **markdown ${truncated}` }]),
    { type: "tool_start", tool_call: call },
    { type: "tool_end", tool_call: call, tool_result: { tool_call_id: call.id, content: `partial output\n${truncated}`, is_error: false } },
  ]);
  mount(<RunProvider store={store}><Message id="message:m" markdown={Markdown} /><ToolCall id="tool:truncated" /></RunProvider>);
  expect(q('[data-part="message"]').textContent).toContain(truncated);
  expect(q('[data-part="tool-output"]').textContent).toContain(truncated);
});

test("mixed blocks render in their order, and streaming appends keep it", () => {
  const { send } = render([{ type: "message_delta", message_id: "m", kind: "reasoning", delta: "let me " }]);
  expect(order()).toEqual(["reasoning"]);
  send({ type: "message_delta", message_id: "m", kind: "reasoning", delta: "check" });
  send({ type: "message_block", message_id: "m", block: { type: "source", kind: "source", url: "https://example.com/a", title: "A" } });
  send({ type: "message_delta", message_id: "m", delta: "the **answer**" });
  expect(order()).toEqual(["reasoning", "source", "md-paragraph"]);
  const paragraph = q('[data-part="md-paragraph"]');
  send({ type: "message_block", message_id: "m", block: { type: "file", kind: "file", url: "https://example.com/r.pdf", filename: "r.pdf" } });
  send({ type: "message_block", message_id: "m", block: { type: "image", url: PNG, alt: "a dot", width: 1, height: 1 } });
  send({ type: "message_delta", message_id: "m", delta: "done" });
  expect(order()).toEqual(["reasoning", "source", "md-paragraph", "file", "image", "md-paragraph"]);
  // The text run that moved from the stream tail into the content is the same element: it did not remount.
  expect(q('[data-part="md-paragraph"]')).toBe(paragraph);
  expect(q('[data-part="message"]').textContent).toContain("the answer");
  send(commit([{ type: "reasoning", text: "let me check" }, { type: "text", text: "the **answer**" }, { type: "custom-chart", series: [1, 2] }]));
  expect(order()).toEqual(["reasoning", "md-paragraph", "block-unknown"]);
});

test("reasoning is a closed named disclosure that says thinking while it streams", () => {
  const { send } = render([{ type: "message_delta", message_id: "m", kind: "reasoning", delta: "first line\nnewest words" }]);
  const details = q('[data-part="reasoning"]') as HTMLDetailsElement;
  expect(details.tagName).toBe("DETAILS");
  expect(details.open).toBe(false);
  expect(details.dataset.state).toBe("streaming");
  expect(q('[data-part="reasoning-name"]').textContent).toBe("reasoning");
  expect(q('[data-part="reasoning-status"]').textContent).toBe("thinking");
  expect(q('[data-part="reasoning-preview"]').textContent).toBe("newest words");
  // A closed disclosure renders no body.
  expect(q('[data-part="reasoning-body"]')).toBeNull();
  act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  expect(q('[data-part="reasoning-body"]').textContent).toContain("newest words");
  send({ type: "message_delta", message_id: "m", delta: "answer" });
  expect(q('[data-part="reasoning"]').dataset.state).toBe("done");
  expect(q('[data-part="reasoning-status"]').textContent).toBe("4 words");
});

test("reasoning is announced once, when it finishes, never per token, and never from history", () => {
  const { send } = render([{ type: "message_delta", message_id: "m", kind: "reasoning", delta: "a" }]);
  const live = () => q('[data-part="reasoning-live"]');
  expect(live().getAttribute("role")).toBe("status");
  const seen: string[] = [];
  const step = (event: RunEvent) => { send(event); seen.push(live().textContent ?? ""); };
  for (const delta of [" b", " c", " d"]) step({ type: "message_delta", message_id: "m", kind: "reasoning", delta });
  step({ type: "message_delta", message_id: "m", delta: "answer" });
  step({ type: "message_delta", message_id: "m", delta: " more" });
  step(commit([{ type: "reasoning", text: "a b c d" }, { type: "text", text: "answer more" }]));
  // Silent for every token; one change, to "reasoning finished", which then stays.
  expect(seen).toEqual(["", "", "", "reasoning finished", "reasoning finished", "reasoning finished"]);
  act(() => root!.unmount());
  root = undefined;
  render([commit([{ type: "reasoning", text: "old thought" }])]);
  expect(live().textContent).toBe("");
});

test("redacted reasoning says so, and empty finished reasoning renders nothing", () => {
  render([commit([{ type: "reasoning", text: "", redacted: true, data: "ZW5jcnlwdGVk" }, { type: "reasoning", text: "" }, { type: "text", text: "ok" }])]);
  expect(order()).toEqual(["reasoning", "md-paragraph"]);
  expect(q('[data-part="reasoning"]').textContent).toBe("reasoningredacted by the provider");
  expect(container.innerHTML).not.toContain("ZW5jcnlwdGVk");
});

test("sources and files show names, types, and sizes, and link only http, https, and mailto", () => {
  render([commit([
    { type: "source", kind: "source", url: "https://example.com/docs/", title: "Docs" },
    { type: "source", kind: "source", url: "javascript:alert(1)", title: "Evil" },
    { type: "source", kind: "source", mediaType: "application/pdf", title: "Guide", filename: "guide.pdf" },
    { type: "source", kind: "source", url: "mailto:a@example.com" },
    { type: "file", kind: "file", url: "https://example.com/files/report%20final.pdf", mediaType: "application/pdf", size: 12_345 },
    { type: "file", kind: "file", url: "data:text/html;base64,PHNjcmlwdD4=", mediaType: "text/html", filename: "page.html" },
  ])]);
  const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  expect(links).toEqual(["https://example.com/docs/", "mailto:a@example.com", "https://example.com/files/report%20final.pdf"]);
  const sources = [...container.querySelectorAll('[data-part="source"]')].map((row) => row.textContent);
  expect(sources).toEqual(["sourceDocsexample.com/docs", "sourceEvil", "sourceGuideapplication/pdf", "sourcea@example.com"]);
  const files = [...container.querySelectorAll('[data-part="file"]')].map((row) => row.textContent);
  expect(files).toEqual(["filereport final.pdfapplication/pdf12.3 kBopen", "filepage.htmltext/html"]);
  for (const a of container.querySelectorAll("a")) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
});

test("images reserve their box, open on click, and refuse unsafe or oversized data", () => {
  const opened: ContentBlock[] = [];
  const big = `data:image/png;base64,${"A".repeat(MAX_URL_CHARS)}`;
  render([commit([
    { type: "image", url: PNG, alt: "a red dot", width: 800, height: 400, mediaType: "image/png", size: 68 },
    { type: "image", url: "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+", filename: "x.svg" },
    { type: "image", url: big },
    { type: "image", url: "https://example.com/shots/screen.webp" },
  ])], { onOpen: (block) => opened.push(block) });
  const images = [...container.querySelectorAll<HTMLElement>('[data-part="image"]')];
  expect(images.map((image) => image.dataset.state)).toEqual(["ready", "blocked", "blocked", "ready"]);
  const open = images[0]!.querySelector<HTMLElement>('[data-part="image-open"]')!;
  // 800x400 drawn at most 360 px tall: 720 px wide, with its aspect ratio reserved before load.
  expect(open.style.width).toBe("720px");
  expect(open.style.aspectRatio).toBe("800 / 400");
  const img = images[0]!.querySelector("img")!;
  expect([img.getAttribute("width"), img.getAttribute("height"), img.alt]).toEqual(["800", "400", "a red dot"]);
  expect(images[1]!.querySelector("img")).toBeNull();
  expect(images[1]!.textContent).toContain("image not shown: unsupported address");
  expect(images[3]!.dataset.size).toBe("unknown");
  expect(images[3]!.querySelector("img")!.alt).toBe("screen.webp");
  act(() => open.click());
  expect(opened).toEqual([expect.objectContaining({ alt: "a red dot" })]);
});

test("retrievable image content wins over omitted history metadata", () => {
  render([commit([
    { type: "image", omitted: true, url: PNG, filename: "retrievable.png" },
    { type: "image", omitted: true, filename: "history.png", width: 640, height: 360 },
    { type: "image", url: "javascript:alert(1)", filename: "unsafe.png" },
  ])]);
  const images = [...container.querySelectorAll<HTMLElement>('[data-part="image"]')];
  expect(images[0]!.dataset.state).toBe("ready");
  expect(images[0]!.querySelector("img")?.getAttribute("src")).toBe(PNG);
  expect(images[1]!.dataset.state).toBe("omitted");
  expect(images[1]!.textContent).toContain("image not kept in history");
  expect((images[1]!.querySelector('[data-part="image-placeholder"]') as HTMLElement).style.aspectRatio).toBe("640 / 360");
  expect(images[1]!.querySelector('[data-action="retry"]')).toBeNull();
  expect(images[2]!.textContent).toContain("image not shown: unsupported address");
});

test("without a host callback an image opens in a dialog", () => {
  render([commit([{ type: "image", url: PNG, alt: "dot" }])]);
  act(() => q('[data-part="image-open"]').click());
  expect(q('[data-part="image-dialog"] img').getAttribute("src")).toBe(PNG);
  act(() => q('[data-part="image-dialog"] [data-action="close"]').click());
  expect(q('[data-part="image-dialog"]')).toBeNull();
});

test("base64 never reaches labels, titles, data attributes, or error text", () => {
  const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
  render([commit([
    { type: "image", url: `data:image/png;base64,${payload}`, mediaType: "image/png" },
    { type: "image", url: `data:image/svg+xml;base64,${payload}` },
    { type: "file", kind: "file", url: `data:application/pdf;base64,${payload}`, mediaType: "application/pdf" },
    { type: "source", kind: "source", url: `data:text/plain;base64,${payload}` },
  ])]);
  for (const element of container.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (element.tagName === "IMG" && attribute.name === "src") continue;
      expect(attribute.value).not.toContain(payload.slice(0, 16));
    }
  }
  expect(container.textContent).not.toContain(payload.slice(0, 16));
  expect([...container.querySelectorAll("img")].map((img) => img.alt)).toEqual(["image"]);
});

test("an unknown block keeps its data: its type, then its json on request, copyable", async () => {
  const block = { type: "custom-chart", series: [1, 2, 3] };
  const copies: string[] = [];
  restoreShims.push(shimProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } }));
  render([commit([block, { type: "constructor" }])]);
  const rows = [...container.querySelectorAll('[data-part="block-unknown"]')];
  expect(rows.map((row) => row.querySelector('[data-part="block-type"]')!.textContent)).toEqual(["custom-chart", "constructor"]);
  expect(q('[data-part="tool-args"]')).toBeNull();
  act(() => q('[data-action="show"]').click());
  expect(q('[data-part="block-unknown"] [data-part="tool-args"]').textContent).toContain('"series"');
  await act(async () => q('[data-action="copy"]').click());
  expect(copies).toEqual([JSON.stringify(block, null, 2)]);
});

test("a host renderer replaces one block type and gets the stable block props", () => {
  const seen: ContentBlockProps[] = [];
  const blocks: BlockRenderers = { source: (props) => { seen.push(props); return <cite data-part="host-source">{String(props.block.title)}</cite>; } };
  render([commit([{ type: "text", text: "see" }, { type: "source", kind: "source", url: "https://example.com", title: "Example" }])], { blocks });
  expect(order()).toEqual(["md-paragraph", "host-source"]);
  expect(seen.at(-1)).toMatchObject({ id: "message:m#1", streaming: false, block: { title: "Example" } });
  expect(typeof seen.at(-1)!.markdown).toBe("object");
});

test("a tool result's image blocks show under its output, and the card opens for them", () => {
  const call = { id: "t1", name: "read", arguments: { path: "chart.png" } };
  const { store } = setup([
    { type: "tool_start", tool_call: call },
    { type: "tool_end", tool_call: call, tool_result: { tool_call_id: "t1", content: "x".repeat(2000), is_error: false, blocks: [{ type: "image", url: PNG, alt: "revenue by quarter", width: 640, height: 480, mediaType: "image/png" }] } },
  ]);
  mount(<RunProvider store={store}><ToolCall id="tool:t1" /></RunProvider>);
  // Long output alone keeps a finished card closed; an image opens it.
  expect((q('[data-part="tool"]') as HTMLDetailsElement).open).toBe(true);
  const body = q('[data-part="tool-body"]');
  expect(body.lastElementChild?.getAttribute("data-part")).toBe("tool-blocks");
  const image = q('[data-part="tool-blocks"] [data-part="image"]');
  expect(image.dataset.size).toBe("known");
  expect(image.querySelector("img")?.getAttribute("alt")).toBe("revenue by quarter");
});

test("omitted lazy images load only near the viewport, keep their reserved box, and revoke object urls", async () => {
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  let seen: IntersectionObserverCallback | undefined;
  const revoked: string[] = [];
  let loads = 0;
  const restoreObserver = shimGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { seen = callback; }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
    root = null; rootMargin = "400px 0px"; thresholds = [0];
  } as unknown as typeof IntersectionObserver);
  URL.createObjectURL = () => "blob:lazy-image";
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  try {
    render([commit([{ type: "image", omitted: true, filename: "history.png", width: 800, height: 400, source: { kind: "lazy", key: "opaque" } }])], {
      loadMedia: async () => { loads++; return new Blob(["png"], { type: "image/png" }); },
    });
    const placeholder = q('[data-part="image-placeholder"]');
    expect(loads).toBe(0);
    expect(placeholder.getAttribute("style")).toContain("aspect-ratio: 800 / 400");
    await act(async () => { seen?.([{ isIntersecting: true, target: q('[data-part="image"]') } as IntersectionObserverEntry], {} as IntersectionObserver); await Promise.resolve(); });
    expect(loads).toBe(1);
    expect(q('[data-part="image-open"]').getAttribute("style")).toContain("aspect-ratio: 800 / 400");
    expect(q("img").getAttribute("src")).toBe("blob:lazy-image");
    act(() => root?.unmount());
    root = undefined;
    await Promise.resolve();
    expect(revoked).toEqual(["blob:lazy-image"]);
  } finally {
    restoreObserver();
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  }
});

test("retry replaces a shared failed image load for every mounted lease", async () => {
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  let calls = 0;
  const { store } = setup([
    { type: "message_commit", message_id: "a", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "shared-failure" } }] } },
    { type: "message_commit", message_id: "b", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "shared-failure" } }] } },
  ]);
  try {
    mount(<RunProvider store={store} loadMedia={async () => {
      calls++;
      if (calls === 1) throw new Error("first load failed");
      return new Blob(["ok"]);
    }}><Message id="message:a" /><Message id="message:b" /></RunProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelectorAll('[data-action="retry"]')).toHaveLength(2);
    await act(async () => { (container.querySelector('[data-action="retry"]') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls).toBe(2);
    expect(container.querySelectorAll("img")).toHaveLength(2);
  } finally {
    restoreObserver();
  }
});

test("simultaneous retries replace a failed generation only once", async () => {
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  const recovered = deferredBlob();
  let calls = 0;
  const { store } = setup([
    { type: "message_commit", message_id: "a", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "simultaneous" } }] } },
    { type: "message_commit", message_id: "b", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "simultaneous" } }] } },
  ]);
  try {
    mount(<RunProvider store={store} loadMedia={() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("first load failed")) : recovered.promise;
    }}><Message id="message:a" /><Message id="message:b" /></RunProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const retries = [...container.querySelectorAll('[data-action="retry"]')] as HTMLButtonElement[];
    await act(async () => {
      retries[0]!.click();
      expect(calls).toBe(2);
      retries[1]!.click();
      await Promise.resolve();
    });
    expect(calls).toBe(2);
    await act(async () => { recovered.resolve(new Blob(["ok"])); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelectorAll("img")).toHaveLength(2);
  } finally {
    restoreObserver();
  }
});

test("a plain-url image shows an error after two decode failures and retry recovers", () => {
  render([commit([{ type: "image", url: PNG, alt: "dot" }])]);
  act(() => q("img").dispatchEvent(new Event("error")));
  act(() => q("img").dispatchEvent(new Event("error")));
  expect(q('[data-part="image"]').dataset.state).toBe("error");
  expect(q('[data-part="image-placeholder"]').textContent).toContain("image failed to load");
  expect(q('[data-action="retry"]')).toBeTruthy();
  act(() => q('[data-action="retry"]').click());
  expect(q('[data-part="image"]').dataset.state).toBe("ready");
  expect(q("img").getAttribute("src")).toBe(PNG);
});

test("a lazy image shows an error after two decode failures and retry recovers", async () => {
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  let calls = 0;
  try {
    render([commit([{ type: "image", source: { kind: "lazy", key: "bad-blob" } }])], {
      loadMedia: async () => { calls++; return new Blob([`blob-${calls}`]); },
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { q("img").dispatchEvent(new Event("error")); await Promise.resolve(); await Promise.resolve(); });
    expect(calls).toBe(2);
    expect(q('[data-part="image"]').dataset.state).toBe("ready");
    await act(async () => { q("img").dispatchEvent(new Event("error")); await Promise.resolve(); });
    expect(calls).toBe(2);
    expect(q('[data-part="image"]').dataset.state).toBe("error");
    expect(q('[data-part="image-placeholder"]').textContent).toContain("image failed to load");
    expect(q('[data-action="retry"]')).toBeTruthy();
    await act(async () => { q('[data-action="retry"]').click(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls).toBe(3);
    expect(q('[data-part="image"]').dataset.state).toBe("ready");
    expect(q("img")).toBeTruthy();
  } finally {
    restoreObserver();
  }
});

test("a sibling decode retry keeps an open full view visible through a slow replacement", async () => {
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  const replacement = deferredBlob();
  const revoked: string[] = [];
  let calls = 0;
  URL.createObjectURL = () => `blob:generation-${calls}`;
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  const { store } = setup([
    { type: "message_commit", message_id: "a", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "slow-shared" } }] } },
    { type: "message_commit", message_id: "b", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "slow-shared" } }] } },
  ]);
  try {
    mount(<RunProvider store={store} loadMedia={() => ++calls === 1 ? Promise.resolve(new Blob(["first"])) : replacement.promise}><Message id="message:a" /><Message id="message:b" /></RunProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const oldUrl = (container.querySelector("img") as HTMLImageElement).src;
    act(() => (container.querySelectorAll('[data-part="image-open"]')[1] as HTMLButtonElement).click());
    await act(async () => { (container.querySelector("img") as HTMLImageElement).dispatchEvent(new Event("error")); await Promise.resolve(); });
    expect(calls).toBe(2);
    expect(container.querySelectorAll(`img[src="${oldUrl}"]`)).toHaveLength(2);
    expect(q('[data-part="image-dialog"] img').getAttribute("src")).toBe(oldUrl);
    expect(revoked).toEqual([]);
    await act(async () => { replacement.resolve(new Blob(["second"])); await Promise.resolve(); await Promise.resolve(); });
    expect(q('[data-part="image-dialog"] img').getAttribute("src")).toBe("blob:generation-2");
  } finally {
    restoreObserver();
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  }
});

test("a replaced image url is revoked once after the last lease commits the new url", async () => {
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  const replacement = deferredBlob();
  const revoked: string[] = [];
  const renderedAtRevoke: number[] = [];
  let calls = 0;
  URL.createObjectURL = () => `blob:generation-${calls}`;
  URL.revokeObjectURL = (url) => { revoked.push(url); renderedAtRevoke.push(container.querySelectorAll(`img[src="${url}"]`).length); };
  const { store } = setup([
    { type: "message_commit", message_id: "a", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "revoke-shared" } }] } },
    { type: "message_commit", message_id: "b", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "revoke-shared" } }] } },
  ]);
  try {
    mount(<RunProvider store={store} loadMedia={() => ++calls === 1 ? Promise.resolve(new Blob(["first"])) : replacement.promise}><Message id="message:a" /><Message id="message:b" /></RunProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const oldUrl = (container.querySelector("img") as HTMLImageElement).src;
    await act(async () => { (container.querySelector("img") as HTMLImageElement).dispatchEvent(new Event("error")); await Promise.resolve(); });
    expect(revoked).toEqual([]);
    await act(async () => { replacement.resolve(new Blob(["second"])); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelectorAll(`img[src="${oldUrl}"]`)).toHaveLength(0);
    expect(revoked).toEqual([oldUrl]);
    expect(renderedAtRevoke).toEqual([0]);
  } finally {
    restoreObserver();
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  }
});

test("a failed replacement keeps good sibling leases on the old url", async () => {
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  const replacement = deferredBlob();
  const revoked: string[] = [];
  let calls = 0;
  URL.createObjectURL = () => `blob:generation-${calls}`;
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  const { store } = setup([
    { type: "message_commit", message_id: "a", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "failed-shared" } }] } },
    { type: "message_commit", message_id: "b", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "failed-shared" } }] } },
  ]);
  try {
    mount(<RunProvider store={store} loadMedia={() => ++calls === 1 ? Promise.resolve(new Blob(["first"])) : replacement.promise}><Message id="message:a" /><Message id="message:b" /></RunProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const oldUrl = (container.querySelector("img") as HTMLImageElement).src;
    await act(async () => { (container.querySelector("img") as HTMLImageElement).dispatchEvent(new Event("error")); replacement.reject(new Error("replacement failed")); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelectorAll(`img[src="${oldUrl}"]`)).toHaveLength(1);
    expect(container.querySelectorAll('[data-action="retry"]')).toHaveLength(1);
    expect(revoked).toEqual([]);
  } finally {
    restoreObserver();
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  }
});

test("100 image retries neither revoke a rendered url nor leak generations", async () => {
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  const revoked: string[] = [];
  let revokedWhileRendered = 0;
  let created = 0;
  URL.createObjectURL = () => `blob:retry-${created++}`;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    if (container.querySelector(`img[src="${url}"]`)) revokedWhileRendered++;
  };
  try {
    render([commit([
      { type: "image", source: { kind: "lazy", key: "retry-100" } },
      { type: "image", source: { kind: "lazy", key: "retry-100" } },
    ])], { loadMedia: async () => new Blob(["image"]) });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    for (let index = 0; index < 100; index++) {
      await act(async () => {
        (container.querySelector("img") as HTMLImageElement).dispatchEvent(new Event("error"));
        await Promise.resolve(); await Promise.resolve();
      });
      const retry = container.querySelector('[data-action="retry"]') as HTMLButtonElement | null;
      if (retry) await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); });
    }
    act(() => root?.unmount());
    root = undefined;
    expect(revokedWhileRendered).toBe(0);
    expect(created).toBe(101);
    expect(revoked).toHaveLength(created);
    expect(new Set(revoked).size).toBe(created);
  } finally {
    restoreObserver();
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  }
});

test("a missing lazy image says it is no longer available and can retry", async () => {
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  let attempts = 0;
  try {
    render([commit([{ type: "image", filename: "gone.png", source: { kind: "lazy", key: "gone" } }])], {
      loadMedia: async () => { attempts++; throw Object.assign(new Error("gone"), { code: "not_available" }); },
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(q('[data-part="image"]').dataset.state).toBe("unavailable");
    expect(q('[data-part="image-placeholder"]').textContent).toContain("image no longer available");
    await act(async () => { q('[data-action="retry"]').click(); await Promise.resolve(); });
    expect(attempts).toBe(2);
  } finally {
    restoreObserver();
  }
});

type Observed = { callback: IntersectionObserverCallback; target?: Element };
const installObservers = (seen: Observed[]) => class {
  constructor(callback: IntersectionObserverCallback) { seen.push({ callback }); }
  observe(target: Element) { seen.at(-1)!.target = target; }
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
  root = null; rootMargin = "400px 0px"; thresholds = [0];
} as unknown as typeof IntersectionObserver;
const intersect = (observed: Observed, value: boolean) => observed.callback([
  { isIntersecting: value, target: observed.target! } as IntersectionObserverEntry,
], {} as IntersectionObserver);
const deferredBlob = () => {
  let resolve!: (blob: Blob) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<Blob>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
};

test("1,000 mounted images and an open full view keep valid urls, then released urls stay bounded", async () => {
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  const observed: Observed[] = [];
  const revoked: string[] = [];
  let next = 0;
  const restoreObserver = shimGlobal("IntersectionObserver", installObservers(observed));
  URL.createObjectURL = () => `blob:${next++}`;
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  try {
    const blocks = Array.from({ length: 1_000 }, (_, index) => ({ type: "image", source: { kind: "lazy" as const, key: `image-${index}` } }));
    const { send } = render([commit(blocks)], { loadMedia: async () => new Blob(["x"]) });
    await act(async () => {
      observed.forEach((entry) => intersect(entry, true));
      await Promise.resolve(); await Promise.resolve();
    });
    act(() => q('[data-part="image-open"]').click());
    expect(q('[data-part="image-dialog"] img').getAttribute("src")).toBe("blob:0");
    expect(revoked).toEqual([]);
    send(commit(blocks.slice(0, 1)));
    await act(async () => { await Promise.resolve(); });
    expect(revoked).not.toContain("blob:0");
    expect(new Set(revoked).size).toBe(967);
  } finally {
    restoreObserver();
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  }
});

test("a pending image read aborts after it leaves the preload margin", async () => {
  const observed: Observed[] = [];
  let aborted = false;
  const restoreObserver = shimGlobal("IntersectionObserver", installObservers(observed));
  try {
    render([commit([{ type: "image", source: { kind: "lazy", key: "pending" } }])], {
      loadMedia: (_block, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true })),
    });
    await act(async () => { intersect(observed[0]!, true); await Promise.resolve(); });
    await act(async () => { intersect(observed[0]!, false); await Promise.resolve(); });
    expect(aborted).toBe(true);
    expect(q('[data-part="image"]').dataset.state).toBe("idle");
  } finally {
    restoreObserver();
  }
});

test("one subscriber can unmount while another keeps the shared read alive", async () => {
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  const pending = deferredBlob();
  let aborted = false;
  const { store } = setup([
    { type: "message_commit", message_id: "a", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "shared" } }] } },
    { type: "message_commit", message_id: "b", message: { role: "assistant", content: [{ type: "image", source: { kind: "lazy", key: "shared" } }] } },
  ]);
  const loader: LoadMedia = (_block, signal) => {
    signal.addEventListener("abort", () => { aborted = true; pending.reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
    return pending.promise;
  };
  try {
    mount(<RunProvider store={store} loadMedia={loader}><Message key="a" id="message:a" /></RunProvider>);
    await act(async () => { await Promise.resolve(); });
    act(() => root!.render(<RunProvider store={store} loadMedia={loader}><Message key="a" id="message:a" /><Message key="b" id="message:b" /></RunProvider>));
    await act(async () => { await Promise.resolve(); });
    act(() => root!.render(<RunProvider store={store} loadMedia={loader}><Message key="b" id="message:b" /></RunProvider>));
    await act(async () => { pending.resolve(new Blob(["ok"])); await Promise.resolve(); await Promise.resolve(); });
    expect(aborted).toBe(false);
    expect(q("img").getAttribute("src")).toStartWith("blob:");
  } finally {
    restoreObserver();
  }
});

test("a late subscriber joins the in-flight read after the first subscriber leaves", async () => {
  const observed: Observed[] = [];
  const pending = deferredBlob();
  let loads = 0;
  const restoreObserver = shimGlobal("IntersectionObserver", installObservers(observed));
  try {
    const { send } = render([commit([{ type: "image", source: { kind: "lazy", key: "same" } }])], {
      loadMedia: () => { loads++; return pending.promise; },
    });
    await act(async () => { intersect(observed[0]!, true); await Promise.resolve(); });
    send(commit([
      { type: "image", source: { kind: "lazy", key: "same" } },
      { type: "image", source: { kind: "lazy", key: "same" } },
    ]));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { intersect(observed[1]!, true); await Promise.resolve(); });
    await act(async () => { intersect(observed[0]!, false); await Promise.resolve(); });
    pending.resolve(new Blob(["ok"]));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(loads).toBe(1);
    expect(container.querySelectorAll("img")).toHaveLength(1);
  } finally {
    restoreObserver();
  }
});

test("changing loaders aborts the old generation and does not reuse its blob", async () => {
  const restoreObserver = shimGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
  const first = deferredBlob();
  let oldAborted = false;
  let loads = 0;
  const one: LoadMedia = (_block, signal) => {
    loads++;
    signal.addEventListener("abort", () => { oldAborted = true; first.reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
    return first.promise;
  };
  const two: LoadMedia = async () => { loads++; return new Blob(["new"]); };
  const { store } = setup([commit([{ type: "image", source: { kind: "lazy", key: "opaque" } }])]);
  try {
    mount(<RunProvider store={store} loadMedia={one}><Message id="message:m" /></RunProvider>);
    await act(async () => { await Promise.resolve(); });
    act(() => root!.render(<RunProvider store={store} loadMedia={two}><Message id="message:m" /></RunProvider>));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(oldAborted).toBe(true);
    expect(loads).toBe(2);
    expect(q("img")).not.toBeNull();
  } finally {
    restoreObserver();
  }
});
