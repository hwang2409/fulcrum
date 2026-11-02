import "../fonts.css";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import themeSource from "@fulcrum/react/themes.css?raw";
import "./gallery.css";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRunStore } from "@fulcrum/core";
import { Approval, RunProvider, Timeline, ToolCall, useItem, type Renderers, type ToolBodyProps } from "@fulcrum/react";
import { demos, type Demo } from "./demos";
import { MarkdownPreview } from "./markdown-preview";

type Act = (action: "approve" | "deny", requestId: string) => void;
const ActContext = createContext<Act>(() => {});

// A sketch of the shell card through the body slot; the real per-tool cards land in @fulcrum/react/tools. The demo
// events carry a shell view, as an adapter would attach, so the shared header already reads `$ command`.
function ShellBody({ item, output, state }: ToolBodyProps) {
  const asking = state === "pending" || state === "submitting";
  return (
    <>
      {asking && item.view?.kind === "shell" ? <pre data-part="shell-command">{item.view.command}</pre> : null}
      {output ? <pre data-part="tool-output">{output}</pre> : null}
    </>
  );
}

function GalleryApproval({ id }: { id: string }) {
  const act = useContext(ActContext);
  const item = useItem(id);
  const name = item?.type === "approval" && item.request.type === "approval_request" ? item.request.tool_call.name : undefined;
  return <Approval id={id} {...(name === "bash" ? { body: ShellBody } : {})} onApprove={(r) => act("approve", r)} onDeny={(r) => act("deny", r)} />;
}
const renderers: Renderers = { approval: GalleryApproval, "tool:bash": ({ id }) => <ToolCall id={id} body={ShellBody} /> };

// A live demo starts empty and plays; paused from the start (reduced motion), it shows its in-progress state instead.
const fresh = (demo: Demo, paused = false) => {
  const store = createRunStore();
  (demo.live ? (paused ? demo.events.slice(0, -1) : []) : demo.events).forEach(store.dispatch);
  return store;
};

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
  const [store, setStore] = useState(() => fresh(demo, reducedMotion));
  const [paused, setPaused] = useState(reducedMotion);
  const [touched, setTouched] = useState(false);
  const [caption, setCaption] = useState("");
  const start = (isPaused: boolean) => (demo.live && isPaused ? demo.events.length - 1 : 0);
  const index = useRef(start(reducedMotion));
  const body = useRef<HTMLDivElement>(null);

  const reset = () => {
    index.current = start(paused);
    setTouched(false);
    setStore(fresh(demo, paused));
  };
  const act: Act = (action, requestId) => {
    store.dispatch({ type: "approval_end", request_id: requestId, data: { action } });
    setTouched(true);
    toast(`${action} ${requestId}`);
  };

  useEffect(() => {
    if (!demo.live || paused) return;
    const timer = setInterval(() => {
      if (index.current < demo.events.length) store.dispatch(demo.events[index.current]);
      if (++index.current > demo.events.length + LOOP_PAUSE_MS / demo.live!) reset();
    }, demo.live);
    return () => clearInterval(timer);
  }, [store, paused]);

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
          {demo.live || touched ? (
            <button type="button" onClick={reset}>
              replay
            </button>
          ) : null}
        </div>
      </header>
      <div className="demo-body" ref={body}>
        {demo.preview === "markdown" ? (
          <MarkdownPreview />
        ) : (
          <ActContext.Provider value={act}>
            <RunProvider store={store}>
              <Timeline renderers={renderers} />
            </RunProvider>
          </ActContext.Provider>
        )}
      </div>
      {inspect ? <pre className="demo-attrs" aria-label="rendered data attributes">{caption}</pre> : null}
    </article>
  );
}

const parts = [...new Set(demos.map((demo) => demo.part))];

const paletteVars = ["bg", "fg", "accent", "ok", "warn", "danger", "tok-keyword", "tok-string", "tok-function"];

function ThemePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="theme">
      <label htmlFor="theme">theme</label>
      <select id="theme" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={AUTO}>auto (github, follows the OS)</option>
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
  const [theme, setTheme] = useState(() => param("theme", themeNames, AUTO));
  const [inspect, setInspect] = useState(() => new URLSearchParams(location.search).get("inspect") === "1");
  const [message, setMessage] = useState<{ text: string; key: number }>();
  const active = useActive(demos.map((demo) => demo.id));
  useLayoutEffect(() => {
    if (theme === AUTO) delete document.documentElement.dataset.fulcrumTheme;
    else document.documentElement.dataset.fulcrumTheme = theme;
    const url = new URL(location.href);
    if (theme === AUTO) url.searchParams.delete("theme");
    else url.searchParams.set("theme", theme);
    if (inspect) url.searchParams.set("inspect", "1");
    else url.searchParams.delete("inspect");
    history.replaceState(null, "", url);
  }, [theme, inspect]);
  // The page renders after load, so the browser cannot jump to a #demo link by itself.
  useEffect(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView(), []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(undefined), 2000);
    return () => clearTimeout(timer);
  }, [message]);
  const toast = (text: string) => setMessage({ text, key: Date.now() });

  return (
    <div className="gallery">
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
            {demos
              .filter((demo) => demo.part === part)
              .map((demo) => (
                <a key={demo.id} href={`#${demo.id}`} aria-current={demo.id === active ? "location" : undefined}>
                  {demo.title}
                </a>
              ))}
          </div>
        ))}
      </nav>
      <main className="main">
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
              &lt;{part} /&gt;<span>{demos.filter((demo) => demo.part === part).length}</span>
            </h2>
            {demos
              .filter((demo) => demo.part === part)
              .map((demo) => (
                <DemoCard key={demo.id} demo={demo} toast={toast} inspect={inspect} />
              ))}
          </section>
        ))}
      </main>
      <div className="toast" role="status" aria-live="polite">
        {message ? <span key={message.key}>{message.text}</span> : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Gallery />);
