import "@fulcrum/react/styles.css";
import "./app.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { Approval, Message, RunProvider, Timeline, useItem, useTimeline, type Renderers } from "@fulcrum/react";
import { connectZeta, parseZetaUrl, type ZetaError } from "@fulcrum/zeta";
import { fromZetaEvent, type EventParams } from "@fulcrum/zeta";
import { replayStep } from "./replay";

const files = import.meta.glob<string>("../../../packages/zeta/test/fixtures/*.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
});
const fixtures = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [
    path.split("/").pop()!,
    text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => fromZetaEvent((JSON.parse(line) as { params: EventParams }).params)),
  ]),
);
const STRESS = "stress";
const STRESS_MESSAGES = 5000;
const STRESS_RATE = 200;

// Sampled by the readout outside React state, so the readout never re-renders the timeline.
let messageRenders = 0;
let dispatched = 0;
let lastAction = "";
let continueReplay = () => {};
function CountedMessage({ id }: { id: string }) {
  useItem(id);
  messageRenders++;
  return <Message id={id} />;
}
function LoggedApproval({ id }: { id: string }) {
  return (
    <Approval
      id={id}
      onApprove={(requestId) => {
        lastAction = `approve ${requestId}`;
        continueReplay();
      }}
      onDeny={(requestId) => {
        lastAction = `deny ${requestId}`;
        continueReplay();
      }}
    />
  );
}
const renderers: Renderers = { message: CountedMessage, approval: LoggedApproval };

function stressSource(): () => RunEvent {
  let n = 0;
  return () => {
    const id = `stream-${Math.floor(n / STRESS_RATE)}`;
    // Commit the streaming message once per second so the timeline also sees appends.
    const event: RunEvent =
      ++n % STRESS_RATE === 0
        ? { type: "message_commit", message_id: id, message: { role: "assistant", content: [{ type: "text", text: `streamed ${STRESS_RATE} deltas` }] } }
        : { type: "message_delta", message_id: id, delta: n % 12 === 0 ? "\n" : "word " };
    return event;
  };
}

function useReplay(mode: string, speed: number, run: number) {
  const [store, setStore] = useState(() => createRunStore());
  // Read on every tick, so moving the slider changes speed without restarting the replay.
  const rate = useRef(speed);
  rate.current = speed;
  useEffect(() => {
    const next = createRunStore();
    let nextEvent: () => RunEvent | undefined;
    let stress = false;
    if (mode === STRESS) {
      for (let i = 0; i < STRESS_MESSAGES; i++)
        next.dispatch({
          type: "message_commit",
          message_id: `m${i}`,
          message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `message ${i}\nsecond line` }] },
        });
      nextEvent = stressSource();
      stress = true;
    } else {
      const events = fixtures[mode] ?? [];
      let i = 0;
      nextEvent = () => events[i++];
    }
    setStore(next);
    dispatched = 0;
    let state = { budget: 0, paused: false, elapsed: 0, rate: rate.current };
    let last = performance.now();
    continueReplay = () => {
      state = { ...state, budget: 0, paused: false };
    };
    const timer = setInterval(() => {
      const now = performance.now();
      state = { ...state, elapsed: now - last, rate: stress ? STRESS_RATE : rate.current };
      last = now;
      const step = replayStep(nextEvent, state);
      state = { ...state, ...step };
      for (const event of step.events) {
        next.dispatch(event);
        dispatched++;
      }
      if (step.done) clearInterval(timer);
    }, 16);
    return () => {
      clearInterval(timer);
      continueReplay = () => {};
    };
  }, [mode, run]);
  return store;
}

function Readout() {
  const items = useTimeline().length;
  const [stats, setStats] = useState({ fps: 0, renders: 0, events: 0, longTasks: 0, heap: undefined as number | undefined });
  useEffect(() => {
    let frames = 0;
    let longTasks = 0;
    const observer = new PerformanceObserver((list) => {
      longTasks += list.getEntries().length;
    });
    observer.observe({ type: "longtask" });
    let raf = requestAnimationFrame(function tick() {
      frames++;
      raf = requestAnimationFrame(tick);
    });
    let start = performance.now();
    let renders = messageRenders;
    const timer = setInterval(() => {
      const seconds = (performance.now() - start) / 1000;
      setStats({
        fps: Math.round(frames / seconds),
        renders: Math.round((messageRenders - renders) / seconds),
        events: dispatched,
        longTasks,
        heap: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize,
      });
      frames = 0;
      renders = messageRenders;
      start = performance.now();
    }, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
      observer.disconnect();
    };
  }, []);
  return (
    <span className="readout" data-testid="readout">
      {stats.fps} fps · {stats.renders} message renders/s · {items} items · {stats.events} events · {stats.longTasks} long tasks{stats.heap === undefined ? "" : ` · ${Math.round(stats.heap / 1_000_000)} MB heap`}{lastAction && ` · ${lastAction}`}
    </span>
  );
}

function Live() {
  const [input, setInput] = useState("");
  const [client, setClient] = useState<Awaited<ReturnType<typeof connectZeta>> | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; name?: string }>>([]);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  useEffect(() => { void fetch("/__fulcrum/zeta").then((response) => response.ok ? response.json() : null).then((value: { url: string; token: string } | null) => { if (value) setInput(`${value.url}?token=${encodeURIComponent(value.token)}`); }).catch(() => {}); }, []);
  const connect = async () => {
    const parsed = parseZetaUrl(input);
    if (!parsed) { setError("paste a loopback websocket url with its token"); return; }
    try {
      const next = await connectZeta(parsed);
      setClient(next);
      const result = await next.request("list_sessions") as { sessions: Array<{ id: string; name?: string }> };
      setSessions(result.sessions ?? []);
      if (result.sessions?.[0]) setSession(result.sessions[0].id);
      else {
        const created = await next.request("new_session", {}) as { session?: { session_id?: string; id?: string }; session_id?: string; id?: string };
        setSession(created.session?.session_id ?? created.session_id ?? created.session?.id ?? created.id ?? null);
      }
      setError("");
    } catch (cause) {
      const kind = (cause as ZetaError).kind;
      setError(kind === "connect_failed" ? "connection failed: check the token, server, and --ws-origin http://localhost:5173 (different from http://127.0.0.1:5173)" : kind === "busy" ? "zeta is busy with another client" : kind === "closed" ? "zeta connection closed" : `zeta error: ${kind ?? "unknown"}`);
    }
  };
  const store = client && session ? client.forSession(session) : createRunStore();
  const approve = (id: string) => void client?.request("approve", { session_id: session, request_id: id });
  const deny = (id: string) => void client?.request("deny", { session_id: session, request_id: id });
  const renderers: Renderers = { approval: ({ id }) => <Approval id={id} onApprove={approve} onDeny={deny} /> };
  return <div className="app live-app"><div className="bar"><strong>live zeta</strong><input aria-label="zeta websocket url" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ws://127.0.0.1:8765/?token=..." /><button type="button" onClick={() => void connect()}>connect</button><select value={session ?? ""} onChange={(e) => setSession(e.target.value)}><option value="">session</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.name ?? item.id}</option>)}</select>{error && <span role="alert">{error}</span>}</div><div className="scroll"><RunProvider store={store}><Timeline renderers={renderers} /></RunProvider></div>{client && session && <form className="composer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void client.request("send", { session_id: session, text }); setText(""); } }}><textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="send a message" /><button type="submit">send</button></form>}</div>;
}

function App() {
  const [live, setLive] = useState(false);
  const [mode, setMode] = useState(Object.keys(fixtures)[0] ?? STRESS);
  const [speed, setSpeed] = useState(20);
  const [run, setRun] = useState(0);
  const store = useReplay(mode, speed, run);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Stick to the bottom while the user has not scrolled up.
    const el = scroll.current!;
    let atBottom = true;
    const onScroll = () => (atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    el.addEventListener("scroll", onScroll);
    let raf = requestAnimationFrame(function tick() {
      if (atBottom && el.scrollTop + el.clientHeight < el.scrollHeight) el.scrollTop = el.scrollHeight;
      raf = requestAnimationFrame(tick);
    });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  if (import.meta.env.DEV && live) return <Live />;
  return (
    <RunProvider store={store}>
      <div className="app">
        <div className="bar">
          {import.meta.env.DEV && <button type="button" onClick={() => setLive(true)}>live zeta</button>}
          <label>
            replay
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {Object.keys(fixtures).map((name) => (
                <option key={name}>{name}</option>
              ))}
              <option value={STRESS}>stress: {STRESS_MESSAGES} messages + {STRESS_RATE} deltas/s</option>
            </select>
          </label>
          <label>
            events/s
            <input type="range" min={1} max={200} value={speed} disabled={mode === STRESS} onChange={(e) => setSpeed(Number(e.target.value))} />
            {mode === STRESS ? STRESS_RATE : speed}
          </label>
          <button type="button" onClick={() => setRun(run + 1)}>restart</button>
          <Readout />
        </div>
        <div className="scroll" ref={scroll}>
          <Timeline renderers={renderers} />
        </div>
      </div>
    </RunProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
