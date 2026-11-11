import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
import { mock } from "bun:test";
import { shimGlobal } from "../../../test-support/dom-shim.js";

mock.module("../src/render.ts", () => { throw new Error("lazy module failed to load"); });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Markdown } = await import("@fulcrum/markdown/react");
const { MermaidFence } = await import("../src/index.tsx");
const restoreAct = shimGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const restoreObserver = shimGlobal("IntersectionObserver", class {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) { queueMicrotask(() => this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
} as unknown as typeof IntersectionObserver);
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
try {
  const source = "graph TD\nA-->B\n";
  await act(() => root.render(<Markdown id="load-failure" source={`\`\`\`mermaid\n${source}\`\`\`\n`} fences={{ mermaid: MermaidFence }} />));
  for (let i = 0; i < 6; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  if (host.querySelector("[data-mermaid-fallback] pre")?.textContent !== source) throw new Error("library load failure did not show the source fallback");
  if (unhandled.length) throw new Error("library load failure became an unhandled rejection");
} finally {
  await act(() => root.unmount());
  host.remove();
  process.off("unhandledRejection", onUnhandled);
  restoreObserver();
  restoreAct();
  GlobalRegistrator.unregister();
}
