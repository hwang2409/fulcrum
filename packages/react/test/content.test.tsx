import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, MAX_DATA_IMAGE_CHARS, type ContentBlock, type RunEvent } from "@fulcrum/core";
import { Markdown } from "../../markdown/src/react.js";
import { Message, RunProvider, type BlockRenderers, type ContentBlockProps } from "../src/index.js";

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
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
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
const order = () => [...q('[data-part="message"]').children].map((child) => (child as HTMLElement).dataset.part).filter((part) => part !== "reasoning-live");
const commit = (content: ContentBlock[], role = "assistant"): RunEvent => ({ type: "message_commit", message_id: "m", message: { role, content } });
const render = (events: RunEvent[], props: { blocks?: BlockRenderers; onOpen?: ContentBlockProps["onOpen"]; markdown?: boolean } = {}) => {
  const setupResult = setup(events);
  mount(<RunProvider store={setupResult.store}><Message id="message:m" markdown={props.markdown === false ? false : Markdown} blocks={props.blocks} onOpen={props.onOpen} /></RunProvider>);
  return setupResult;
};

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("a plain text message renders exactly as before content blocks", () => {
  render([commit([{ type: "text", text: "hello\nthere" }], "user")]);
  expect(container.innerHTML).toBe('<div style="white-space: pre-wrap;" data-part="message" data-kind="message" data-id="message:m" data-role="user" data-state="done" data-format="text">hello\nthere</div>');
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
  const big = `data:image/png;base64,${"A".repeat(MAX_DATA_IMAGE_CHARS)}`;
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
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
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
