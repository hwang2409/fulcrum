import "../fonts.css";
import baseline from "@fulcrum/react/styles.css?inline";
import folio from "./directions/folio.css?inline";
import trace from "./directions/trace.css?inline";
import pebble from "./directions/pebble.css?inline";
import themes from "./themes.css?inline";
import "./gallery.css";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRunStore } from "@fulcrum/core";
import { Markdown } from "@fulcrum/markdown/react";
import { Approval, Message, RunProvider, Timeline, type Renderers } from "@fulcrum/react";
import { demos, type Demo } from "./demos";

type Act = (action: "approve" | "deny", requestId: string) => void;
const ActContext = createContext<Act>(() => {});
function GalleryApproval({ id }: { id: string }) {
  const act = useContext(ActContext);
  return <Approval id={id} onApprove={(r) => act("approve", r)} onDeny={(r) => act("deny", r)} />;
}
const renderers: Renderers = {
  message: ({ id }) => <Message id={id} markdown={Markdown} />,
  approval: GalleryApproval,
};

const fresh = (demo: Demo) => {
  const store = createRunStore();
  if (!demo.live) demo.events.forEach(store.dispatch);
  return store;
};

// Candidate replacements for styles.css (shape, density, motion). Themes (color) apply on top of any of them.
const directions: Record<string, { css: string; note: string }> = {
  baseline: { css: baseline, note: "The shipped styles.css, unchanged: system type and bordered boxes. Compare the others against it." },
  folio: { css: folio, note: "Quiet and editorial. Calm prose, tools as margin notes, color only where the run needs you." },
  trace: { css: trace, note: "Dense and technical. One-line tool rows, a status rail, terminal output, a hazard band on approvals." },
  pebble: { css: pebble, note: "Soft product UI. Chat bubbles, rounded cards, a sweep while tools run, a halo on approvals." },
};
const themeNames = ["light", "dark", "pine", "graphite", "iris", "phosphor"];
// One style element, direction first, so a theme always wins over the direction's own colors.
const partStyle = document.head.appendChild(document.createElement("style"));
const param = (name: string, allowed: string[], fallback: string) => {
  const value = new URLSearchParams(location.search).get(name);
  return value && allowed.includes(value) ? value : fallback;
};
const systemTheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

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
  const [store, setStore] = useState(() => fresh(demo));
  const [paused, setPaused] = useState(reducedMotion);
  const [touched, setTouched] = useState(false);
  const [caption, setCaption] = useState("");
  const index = useRef(0);
  const body = useRef<HTMLDivElement>(null);

  const reset = () => {
    index.current = 0;
    setTouched(false);
    setStore(fresh(demo));
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
            {demo.live ? <span className="chip" data-paused={paused || undefined}>{paused ? "paused" : "live"}</span> : null}
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
        <ActContext.Provider value={act}>
          <RunProvider store={store}>
            <Timeline renderers={renderers} />
          </RunProvider>
        </ActContext.Provider>
      </div>
      {inspect ? <pre className="demo-attrs" aria-label="rendered data attributes">{caption}</pre> : null}
    </article>
  );
}

const parts = [...new Set(demos.map((demo) => demo.part))];

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option} type="button" role="radio" aria-checked={option === value} onClick={() => onChange(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

// Each swatch carries its own data-fulcrum-theme, so it paints with that theme's variables.
function ThemePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="theme">
      {themeNames.map((name) => (
        <button key={name} type="button" role="radio" aria-checked={name === value} onClick={() => onChange(name)}>
          <span className="swatch" data-fulcrum-theme={name} />
          <span className="swatch-name">{name}</span>
        </button>
      ))}
      <span className="theme-name">{value}</span>
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
  const [theme, setTheme] = useState(() => param("theme", themeNames, systemTheme));
  const [direction, setDirection] = useState(() => param("direction", Object.keys(directions), "baseline"));
  const [inspect, setInspect] = useState(() => new URLSearchParams(location.search).get("inspect") === "1");
  const [message, setMessage] = useState<{ text: string; key: number }>();
  const active = useActive(demos.map((demo) => demo.id));
  useLayoutEffect(() => {
    document.documentElement.dataset.fulcrumTheme = theme;
    partStyle.textContent = directions[direction].css + themes;
    const url = new URL(location.href);
    url.searchParams.set("direction", direction);
    url.searchParams.set("theme", theme);
    if (inspect) url.searchParams.set("inspect", "1");
    else url.searchParams.delete("inspect");
    history.replaceState(null, "", url);
  }, [theme, direction, inspect]);
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
          <span className="brand-mark" aria-hidden="true" />
          fulcrum
          <span className="brand-sub">gallery</span>
        </a>
        <div className="controls">
          <Segmented label="direction" value={direction} options={Object.keys(directions)} onChange={setDirection} />
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
            Every <code>@fulcrum/react</code> part, rendered from <code>@fulcrum/core</code> events. No server, no
            session. {parts.length} parts, {demos.length} demos. Turn on <strong>inspect</strong> to see the{" "}
            <code>data-*</code> attributes each part renders.
          </p>
          <p className="direction-note" key={direction}>
            <strong>{direction}</strong> {directions[direction].note}
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
