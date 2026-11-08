import "../fonts.css";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import "@fulcrum/highlight/styles.css";
import "@fulcrum/mermaid/styles.css";
import themeSource from "@fulcrum/react/themes.css?raw";
import "./gallery.css";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRunStore, type RunSource } from "@fulcrum/core";
import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { MermaidFence } from "@fulcrum/mermaid";
import { Approval, Message, RunEndMarker, RunNavigator, RunProvider, RunStatus, Timeline, useHistoryRunPath, useRunNavigation, type Renderers, type RunLocation } from "@fulcrum/react";
import { CodeCard, codeDemos } from "./code-demos";
import { ComposerCard, composerDemos } from "./composer-demos";
import { demos, type Demo, type DemoApproval } from "./demos";
import { mermaidDemos } from "./mermaid-demos";

const highlight = createHighlighter();
const fences: Fences = { mermaid: MermaidFence };
const RichMarkdown = (props: MarkdownProps) => <Markdown {...props} highlight={highlight} fences={fences} />;

/** `path` is the open run path when the approval renders inside a RunNavigator. */
type Act = (action: "approve" | "approve-always" | "deny", requestId: string, path?: readonly RunLocation[]) => void | Promise<void>;
const HostContext = createContext<{ act: Act; approval?: DemoApproval }>({ act: () => {} });

function GalleryApproval({ id }: { id: string }) {
  const { act, approval } = useContext(HostContext);
  const path = useRunNavigation()?.path;
  const always = approval?.always?.includes(id.slice("approval:".length));
  return <Approval id={id} onApprove={(r) => act("approve", r, path)} onApproveAlways={always ? (r) => act("approve-always", r, path) : undefined} approveAlwaysLabel={approval?.label} onDeny={(r) => act("deny", r, path)} disabledReason={approval?.disabledReason} />;
}
// Tools use ToolCall's default body; messages use the shared highlighted markdown renderer.
const renderers: Renderers = {
  message: ({ id }) => <Message id={id} markdown={RichMarkdown} />,
  approval: GalleryApproval,
};
const markdownAllRenderers: Renderers = { ...renderers, message: ({ id }) => <Message id={id} markdown={RichMarkdown} markdownFor="all" /> };
const plainRenderers: Renderers = { ...renderers, message: ({ id }) => <Message id={id} markdown={false} /> };

// A live demo starts empty and plays; paused from the start (reduced motion), it shows its in-progress state instead.
// A demo with child runs shows its finished state when paused, since it plays once and stops.
const fresh = (demo: Demo, paused = false) => {
  const store = demo.id === "text-viewer-check" ? createRunStore((flush) => flush()) : createRunStore();
  (demo.live ? (paused ? (demo.runs ? demo.events : demo.events.slice(0, -1)) : []) : demo.events).forEach(store.dispatch);
  const runs = Object.fromEntries(Object.entries(demo.runs ?? {}).map(([runId, events]) => {
    const child = createRunStore();
    (!demo.live || paused ? events : []).forEach(child.dispatch);
    return [runId, child];
  }));
  return { store, runs };
};
const steps = (demo: Demo) => Math.max(demo.events.length, ...Object.values(demo.runs ?? {}).map((events) => events.length));

// The fake harness behind the sub-agent demos: child runs it has open, the rest say why they cannot.
const sourceFor = (runs: Record<string, ReturnType<typeof createRunStore>>): RunSource => ({
  open: (runId) => ({ store: runs[runId]!, release() {} }),
  unavailable: (runId) => (runs[runId] ? undefined : "started before child runs were recorded"),
});

// The theme list comes from the shipped themes.css, so the picker never drifts from it.
const themeNames = [...themeSource.matchAll(/^\[data-fulcrum-theme="([^"]+)"\] \{$/gm)].map((match) => match[1]);
const AUTO = "auto";
const param = (name: string, allowed: string[], fallback: string) => {
  const value = new URLSearchParams(location.search).get(name);
  return value && allowed.includes(value) ? value : fallback;
};

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const LOOP_PAUSE_MS = 1500;

// Reads the attributes from the DOM, so the caption shows exactly what the parts render.
function attributes(root: HTMLElement) {
  const lines = [...root.querySelectorAll<HTMLElement>('[data-part="timeline"], [data-kind]')].map((node) =>
    [...node.attributes]
      .filter((attr) => attr.name.startsWith("data-") && attr.name !== "data-id")
      .map((attr) => `${attr.name}="${attr.value}"`)
      .join(" "),
  );
  return [...new Set(lines)].join("\n");
}

function DemoCard({ demo, toast, inspect }: { demo: Demo; toast: (message: string) => void; inspect: boolean }) {
  const [stores, setStores] = useState(() => fresh(demo, reducedMotion));
  const { store, runs } = stores;
  const source = useMemo(() => sourceFor(runs), [runs]);
  const [generation, setGeneration] = useState(0);
  const [paused, setPaused] = useState(reducedMotion);
  const [touched, setTouched] = useState(false);
  const held = useRef<(() => void)[]>([]);
  const [holding, setHolding] = useState(0);
  const [caption, setCaption] = useState("");
  const start = (isPaused: boolean) => (demo.live && isPaused ? (demo.runs ? steps(demo) : demo.events.length - 1) : 0);
  const index = useRef(start(reducedMotion));
  const body = useRef<HTMLDivElement>(null);
  // The open sub-agent path lives in the URL (?<demo id>=<run id>), so reload, links, and browser back work.
  const runPath = useHistoryRunPath(demo.id);

  const reset = () => {
    // New stores are new runs: the navigator corrects the URL to the root in place.
    runPath.onPathChange([], { replace: true });
    index.current = start(paused);
    setTouched(false);
    setStores(fresh(demo, paused));
    setGeneration((value) => value + 1);
    held.current = [];
    setHolding(0);
  };
  const act: Act = (action, requestId, path = []) => {
    // A held decision stays "approving" until the header's answer button; a rejected one shows the host's error.
    if (demo.approval?.reply === "reject") return new Promise((_, reject) => setTimeout(() => reject(new Error("the host could not send this decision: connection reset")), 400));
    if (demo.approval?.reply === "hold") return new Promise((resolve) => {
      held.current.push(() => { decided(action, requestId, path); resolve(); });
      setHolding(held.current.length);
    });
    decided(action, requestId, path);
  };
  const decided = (action: Parameters<Act>[0], requestId: string, path: readonly RunLocation[]) => {
    const storeOf = (location: RunLocation | undefined) => (location?.runId ? runs[location.runId]! : store);
    storeOf(path.at(-1)).dispatch({ type: "approval_end", request_id: requestId, decision: action === "deny" ? "deny" : "approve", data: { action } });
    // The fake harness clears the waiting badge on every ancestor row, as a real one would once the child resumes.
    path.slice(1).forEach((location, index) => {
      const row = storeOf(path[index]).getItem(`sub-agent:${location.runId}`);
      if (row?.type === "sub_agent" && row.urgency === "approval")
        storeOf(path[index]).dispatch({ type: "sub_agent", childRunId: location.runId!, status: "running", latestActivity: `${action === "deny" ? "denied" : "approved"}: resuming` });
    });
    setTouched(true);
    toast(`${action} ${requestId}`);
  };

  useEffect(() => {
    if (!demo.live || paused) return;
    const total = steps(demo);
    const timer = setInterval(() => {
      const at = index.current;
      if (at < demo.events.length) store.dispatch(demo.events[at]);
      for (const [runId, events] of Object.entries(demo.runs ?? {})) if (at < events.length) runs[runId]!.dispatch(events[at]);
      if (++index.current > total + LOOP_PAUSE_MS / demo.live!) {
        if (demo.runs) clearInterval(timer);
        else reset();
      }
    }, demo.live);
    return () => clearInterval(timer);
  }, [store, paused]);

  useEffect(() => {
    if (demo.id !== "text-viewer-check") return;
    const target = window as typeof window & { __appendViewerFixture?: (delta: string) => void };
    target.__appendViewerFixture = (delta) => store.dispatch({
      type: "tool_output",
      tool_call: { id: "viewer-check", name: "bash", arguments: { command: "stream fixture" } },
      output: delta,
    });
    return () => { delete target.__appendViewerFixture; };
  }, [demo.id, store]);

  // A demo that describes a tool's body ("the body says so in words") opens on it.
  useLayoutEffect(() => {
    if (demo.open) body.current!.querySelectorAll<HTMLDetailsElement>("details[data-part=tool]:not([open])").forEach((card) => { card.open = true; });
  }, [generation]);

  useEffect(() => {
    if (!inspect) return;
    const root = body.current!;
    const read = () => setCaption(attributes(root));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
    return () => observer.disconnect();
  }, [inspect]);

  return (
    <article className="demo" id={demo.id}>
      <header className="demo-head">
        <div>
          <h3>
            <a href={`#${demo.id}`}>{demo.title}</a>
            {demo.live ? <span className="live" data-paused={paused || undefined}>{paused ? "paused" : "live"}</span> : null}
          </h3>
          <p>{demo.description}</p>
        </div>
        <div className="demo-actions">
          {demo.live ? (
            <button type="button" onClick={() => setPaused(!paused)} aria-pressed={paused}>
              {paused ? "play" : "pause"}
            </button>
          ) : null}
          {holding ? (
            <button type="button" onClick={() => { held.current.splice(0).forEach((answer) => answer()); setHolding(0); }}>
              answer
            </button>
          ) : null}
          {demo.live || touched ? (
            <button type="button" onClick={reset}>
              replay
            </button>
          ) : null}
        </div>
      </header>
      <div className="demo-body" ref={body}>
        <HostContext.Provider value={{ act, approval: demo.approval }}>
          {demo.runs ? (
            <RunNavigator key={generation} store={store} source={source} {...runPath} highlight={highlight} renderers={renderers} label="run" />
          ) : (
            <RunProvider key={generation} store={store} highlight={highlight}>
              {demo.part === "RunStatus" ? <RunStatus /> : null}
              <Timeline renderers={demo.markdownAll ? markdownAllRenderers : demo.plain ? plainRenderers : renderers} />
              {demo.part === "RunEndMarker" ? <RunEndMarker /> : null}
            </RunProvider>
          )}
        </HostContext.Provider>
      </div>
      {inspect ? <pre className="demo-attrs" aria-label="rendered data attributes">{caption}</pre> : null}
    </article>
  );
}

// Every card in page order: the run parts, the composer that sits under a run, then highlighted text outside a run.
const cards = [...demos, ...mermaidDemos, ...composerDemos, ...codeDemos];
const parts = [...new Set(cards.map((demo) => demo.part))];

const paletteVars = ["bg", "fg", "accent", "ok", "warn", "danger", "tok-keyword", "tok-string", "tok-function"];

function ThemePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="theme">
      <label htmlFor="theme">theme</label>
      <select id="theme" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={AUTO}>auto (github, OS)</option>
        {themeNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <span className="palette" aria-hidden="true">
        {paletteVars.map((name) => (
          <span key={name} style={{ background: `var(--fulcrum-${name})` }} />
        ))}
      </span>
    </div>
  );
}

// Marks the nav link of the demo nearest the top of the viewport.
function useActive(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.find((entry) => entry.isIntersecting);
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    ids.forEach((id) => observer.observe(document.getElementById(id)!));
    return () => observer.disconnect();
  }, []);
  return active;
}

function Gallery() {
  useEffect(() => () => highlight.dispose(), []);
  const [theme, setTheme] = useState(() => param("theme", themeNames, AUTO));
  const [inspect, setInspect] = useState(() => new URLSearchParams(location.search).get("inspect") === "1");
  const [message, setMessage] = useState<{ text: string; key: number }>();
  const active = useActive(cards.map((demo) => demo.id));
  useLayoutEffect(() => {
    if (theme === AUTO) delete document.documentElement.dataset.fulcrumTheme;
    else document.documentElement.dataset.fulcrumTheme = theme;
    const url = new URL(location.href);
    if (theme === AUTO) url.searchParams.delete("theme");
    else url.searchParams.set("theme", theme);
    if (inspect) url.searchParams.set("inspect", "1");
    else url.searchParams.delete("inspect");
    history.replaceState(history.state, "", url); // keeps the run paths in the URL
  }, [theme, inspect]);
  // The page renders after load, so the browser cannot jump to a #demo link by itself. A run path link
  // (?run-navigator-nested=reviewer) has no #id; it lands on the demo that its parameter names.
  useEffect(() => {
    const target = decodeURIComponent(location.hash.slice(1)) || [...new URLSearchParams(location.search).keys()].find((key) => cards.some((demo) => demo.id === key));
    if (target) document.getElementById(target)?.scrollIntoView();
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(undefined), 2000);
    return () => clearTimeout(timer);
  }, [message]);
  const toast = (text: string) => setMessage({ text, key: Date.now() });

  return (
    <div className="gallery">
      <a className="skip" href="#main">skip to content</a>
      <header className="topbar">
        <a className="brand" href="#">
          fulcrum
          <span className="brand-sub">gallery</span>
        </a>
        <div className="controls">
          <ThemePicker value={theme} onChange={setTheme} />
          <button type="button" className="inspect" aria-pressed={inspect} onClick={() => setInspect(!inspect)}>
            inspect
          </button>
        </div>
      </header>
      <nav className="nav" aria-label="components">
        {parts.map((part) => (
          <div key={part} className="nav-group">
            <a className="nav-part" href={`#${part}`}>
              {part}
            </a>
            {cards
              .filter((demo) => demo.part === part)
              .map((demo) => (
                <a key={demo.id} href={`#${demo.id}`} aria-current={demo.id === active ? "location" : undefined}>
                  {demo.title}
                </a>
              ))}
          </div>
        ))}
      </nav>
      {/* Narrow screens hide the side nav; a sticky jump list keeps every demo one tap away. */}
      <label className="jump">
        <span>jump to</span>
        <select
          value={active}
          onChange={(event) => {
            history.replaceState(history.state, "", `#${event.target.value}`);
            document.getElementById(event.target.value)?.scrollIntoView();
          }}
        >
          {parts.map((part) => (
            <optgroup key={part} label={part}>
              {cards.filter((demo) => demo.part === part).map((demo) => <option key={demo.id} value={demo.id}>{demo.title}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <main className="main" id="main" tabIndex={-1}>
        <header className="intro">
          <h1>Agent UI parts, in every state.</h1>
          <p>
            Every <code>@fulcrum/react</code> part, rendered from <code>@fulcrum/core</code> events with the shipped{" "}
            <code>styles.css</code> and one of {themeNames.length} palettes from <code>themes.css</code>. No server, no
            session. Turn on <strong>inspect</strong> to see the <code>data-*</code> attributes each part renders.
          </p>
        </header>
        {parts.map((part) => (
          <section key={part} id={part} className="part">
            <h2>
              &lt;{part} /&gt;<span>{cards.filter((demo) => demo.part === part).length}</span>
            </h2>
            {cards
              .filter((demo) => demo.part === part)
              .map((demo) => "events" in demo
                ? <DemoCard key={demo.id} demo={demo} toast={toast} inspect={inspect} />
                : demo.part === "Code"
                  ? <CodeCard key={demo.id} demo={demo} highlight={highlight} />
                  : <ComposerCard key={demo.id} demo={demo} toast={toast} />)}
          </section>
        ))}
      </main>
      <div className="toast" role="status" aria-live="polite">
        {message ? <span key={message.key}>{message.text}</span> : null}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Gallery />);
// The layout check unmounts the gallery, as a host router leaving the page would, to prove that leaves history alone.
(window as { unmountGallery?: () => void }).unmountGallery = () => root.unmount();
