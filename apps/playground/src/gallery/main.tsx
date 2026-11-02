import "@fulcrum/react/styles.css";
import "./gallery.css";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRunStore } from "@fulcrum/core";
import { Approval, RunProvider, Timeline, type Renderers } from "@fulcrum/react";
import { demos, type Demo } from "./demos";

type Act = (action: "approve" | "deny", requestId: string) => void;
const ActContext = createContext<Act>(() => {});
function GalleryApproval({ id }: { id: string }) {
  const act = useContext(ActContext);
  return <Approval id={id} onApprove={(r) => act("approve", r)} onDeny={(r) => act("deny", r)} />;
}
const renderers: Renderers = { approval: GalleryApproval };

const fresh = (demo: Demo) => {
  const store = createRunStore();
  if (!demo.live) demo.events.forEach(store.dispatch);
  return store;
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

function DemoCard({ demo, toast }: { demo: Demo; toast: (message: string) => void }) {
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
    const root = body.current!;
    const read = () => setCaption(attributes(root));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
    return () => observer.disconnect();
  }, []);

  return (
    <article className="demo" id={demo.id}>
      <header className="demo-head">
        <div>
          <h3>
            <a href={`#${demo.id}`}>{demo.title}</a>
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
      <pre className="demo-attrs">{caption}</pre>
    </article>
  );
}

const parts = [...new Set(demos.map((demo) => demo.part))];
const systemTheme = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

function Gallery() {
  const [theme, setTheme] = useState(systemTheme);
  const [message, setMessage] = useState<{ text: string; key: number }>();
  useEffect(() => {
    document.documentElement.dataset.fulcrumTheme = theme;
  }, [theme]);
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
      <nav className="nav" aria-label="components">
        <a className="brand" href="#">
          fulcrum
        </a>
        {parts.map((part) => (
          <div key={part} className="nav-group">
            <a className="nav-part" href={`#${part}`}>
              {part}
            </a>
            {demos
              .filter((demo) => demo.part === part)
              .map((demo) => (
                <a key={demo.id} href={`#${demo.id}`}>
                  {demo.title}
                </a>
              ))}
          </div>
        ))}
      </nav>
      <main className="main">
        <header className="intro">
          <div>
            <h1>component gallery</h1>
            <p>
              Every <code>@fulcrum/react</code> part in every state, built from <code>@fulcrum/core</code> events with
              the default <code>styles.css</code>. No server, no session.
            </p>
          </div>
          <button type="button" className="theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "light" : "dark"} theme
          </button>
        </header>
        {parts.map((part) => (
          <section key={part} id={part} className="part">
            <h2>{part}</h2>
            {demos
              .filter((demo) => demo.part === part)
              .map((demo) => (
                <DemoCard key={demo.id} demo={demo} toast={toast} />
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
