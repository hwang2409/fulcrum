import "@fulcrum/highlight/styles.css";
import "@fulcrum/mermaid/styles.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRunStore, initialState, type RunEvent, type RunItem } from "@fulcrum/core";
import { createAiSdkAdapter } from "@fulcrum/ai-sdk";
import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { MermaidFence } from "@fulcrum/mermaid";
import { Approval, Message, RunProvider, Timeline, useItem, useTimeline, type Renderers } from "@fulcrum/react";
import { connectZeta, discoverZeta, parseConnectFragment, parseZetaUrl, type ZetaError } from "@fulcrum/zeta";
import { fromZetaEvent, type EventParams } from "@fulcrum/zeta";
import { relabel, replayStep } from "./replay";
import { Shell } from "./shell";

const zetaFiles = import.meta.glob<string>("../../../packages/zeta/test/fixtures/*.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
});
const zetaFixtures = Object.fromEntries(
  Object.entries(zetaFiles).map(([path, text]) => [
    path.split("/").pop()!,
    text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => fromZetaEvent((JSON.parse(line) as { params: EventParams }).params)),
  ]),
);
const aiSdkFiles = import.meta.glob<string>("../../../packages/ai-sdk/test/fixtures/playground.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
});
const aiSdkFixtures = Object.fromEntries(
  // A recorded host session: each stream's chunks under its stream key (one adapter each), and the events the host
  // dispatched between them (respondToApproval's approval_end).
  Object.entries(aiSdkFiles).map(([path, text]) => {
    const adapters = new Map<string, ReturnType<typeof createAiSdkAdapter>>();
    const decode = ({ stream, part, event }: { stream?: string; part?: unknown; event?: RunEvent }) => {
      if (event) return [event];
      const adapter = adapters.get(stream!) ?? createAiSdkAdapter({ streamKey: stream! });
      adapters.set(stream!, adapter);
      return adapter.decode(part);
    };
    return [path.split("/").pop()!, text.split("\n").filter(Boolean).flatMap((line) => decode(JSON.parse(line)))];
  }),
);
const demoFixtures: Record<string, RunEvent[]> = {
  "markdown-code": [{
    type: "message_commit",
    message_id: "markdown-code",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Here is a focused TypeScript fix:\n\n```ts\nconst retries = Math.min(attempt + 1, 3);\nawait runTask({ retries });\n```\n\nThe retry count stays bounded." }],
    },
  }],
};
const fixtureSources: Record<string, Record<string, RunEvent[]>> = { demo: demoFixtures, zeta: zetaFixtures, "ai-sdk": aiSdkFixtures };
const fixtures = Object.fromEntries(Object.entries(fixtureSources).flatMap(([source, sourceFixtures]) =>
  Object.entries(sourceFixtures).map(([name, events]) => [`${source}:${name}`, events]),
));
const STRESS = "stress";
const STATIC = "static:";
const STRESS_MESSAGES = Number(new URLSearchParams(location.search).get("stressMessages")) || 5000;
const HUGE_MESSAGES = 100_000;
const HUGE = `${STATIC}${HUGE_MESSAGES}`;
const STRESS_RATE = 200;
const REPLAY_STORE_LAPS = 8;
const highlight = createHighlighter();
const fences: Fences = { mermaid: MermaidFence };
const RichMarkdown = (props: MarkdownProps) => <Markdown {...props} highlight={highlight} fences={fences} />;
addEventListener("pagehide", () => highlight.dispose(), { once: true });

// Sampled by the readout outside React state, so the readout never re-renders the timeline.
let messageRenders = 0;
let dispatched = 0;
let lastAction = "";
let lap = 0;
type Phase = "streaming" | "waiting" | "static";
let phase: Phase = "streaming";
const phaseListeners = new Set<(phase: Phase) => void>();
const setPhase = (next: Phase) => {
  if (phase === next) return;
  phase = next;
  phaseListeners.forEach((listener) => listener(next));
};
let continueReplay = () => {};
function CountedMessage({ id }: { id: string }) {
  useItem(id);
  messageRenders++;
  return <Message id={id} markdown={RichMarkdown} />;
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

function staticStore(count: number): ReturnType<typeof createRunStore> {
  const outline = Array.from({ length: count }, (_, index) => ({ id: `static:${index}`, kind: "message" as const }));
  const entities = new Map<string, RunItem>();
  const getItem = (id: string) => {
    let item = entities.get(id);
    if (!item) {
      const index = id.slice(id.indexOf(":") + 1);
      item = { id, type: "message", message: { role: Number(index) % 2 ? "assistant" : "user", content: [{ type: "text", text: `message ${index}\\nsecond line` }] }, version: 1, active: false };
      entities.set(id, item);
    }
    return item;
  };
  const state = { ...structuredClone(initialState), outline };
  const snapshot = { items: outline, change: null };
  const diagnostics = { ignoredEvents: 0, sanitizedFields: 0, desynced: false };
  const subscribe = (() => () => {}) as ReturnType<typeof createRunStore>["subscribe"];
  return { getState: () => state, getItem, getOutline: () => outline, getOutlineSnapshot: () => snapshot, hasMessageDelivery: () => false, getDiagnostics: () => diagnostics, subscribeDiagnostics: () => () => true, resyncFailed: () => {}, resync: () => {}, beginHistory: () => {}, endHistory: () => {}, prepend: () => {}, subscribe, subscribeOutline: () => () => true, dispatch: () => {}, dispose: () => {} };
}

function useReplay(mode: string, speed: number, run: number) {
  const [store, setStore] = useState(() => createRunStore());
  // Read on every tick, so moving the slider changes speed without restarting the replay.
  const rate = useRef(speed);
  rate.current = speed;
  useEffect(() => {
    const next = createRunStore();
    let active = next;
    let nextEvent: () => RunEvent | undefined;
    let stress = false;
    if (mode.startsWith(STATIC)) {
      const fixed = staticStore(Number(mode.slice(STATIC.length)));
      setStore(fixed);
      dispatched = 0;
      setPhase("static");
      return () => fixed.dispose();
    }
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
      // Keep enough laps for follow testing, then rotate the store so an unattended replay stays bounded.
      const events = fixtures[mode] ?? [];
      let i = 0;
      nextEvent = () => {
        if (!events.length) return undefined;
        lap = Math.floor(i / events.length);
        if (lap > 0 && lap % REPLAY_STORE_LAPS === 0 && i % events.length === 0) {
          active = createRunStore();
          setStore(active);
        }
        return relabel(events[i++ % events.length]!, lap);
      };
    }
    setStore(next);
    dispatched = 0;
    lap = 0;
    setPhase("streaming");
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
      setPhase(step.done ? "static" : step.paused ? "waiting" : "streaming");
      for (const event of step.events) {
        active.dispatch(event);
        dispatched++;
      }
      if (step.done) clearInterval(timer);
    }, 16);
    return () => {
      clearInterval(timer);
      active.dispose();
      continueReplay = () => {};
    };
  }, [mode, run]);
  const committedStore = useRef(store);
  useEffect(() => {
    const retired = committedStore.current;
    committedStore.current = store;
    if (retired !== store) retired.dispose();
  }, [store]);
  return store;
}

// The active mode and its live numbers. Sampled twice a second, so it never re-renders the timeline.
function Status({ label }: { label: string }) {
  const items = useTimeline().length;
  const [activePhase, setActivePhase] = useState(phase);
  const frames = useRef(0);
  const [stats, setStats] = useState({ fps: 0, renders: 0, events: 0, longTasks: 0, heap: undefined as number | undefined, lap: 0 });
  useEffect(() => {
    phaseListeners.add(setActivePhase);
    return () => { phaseListeners.delete(setActivePhase); };
  }, []);
  useEffect(() => {
    if (activePhase !== "streaming") { frames.current = 0; return; }
    let raf = requestAnimationFrame(function tick() {
      frames.current++;
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [activePhase]);
  useEffect(() => {
    let longTasks = 0;
    const observer = new PerformanceObserver((list) => {
      longTasks += list.getEntries().length;
    });
    observer.observe({ type: "longtask" });
    let start = performance.now();
    let renders = messageRenders;
    const timer = setInterval(() => {
      const seconds = (performance.now() - start) / 1000;
      setStats({
        fps: Math.round(frames.current / seconds),
        renders: Math.round((messageRenders - renders) / seconds),
        events: dispatched,
        longTasks,
        heap: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize,
        lap,
      });
      frames.current = 0;
      renders = messageRenders;
      start = performance.now();
    }, 500);
    return () => {
      clearInterval(timer);
      observer.disconnect();
    };
  }, []);
  return (
    <div className="status">
      <span className="mode" data-state={activePhase}>
        {label}
        <span>{activePhase === "waiting" ? "waiting for approval" : activePhase === "static" ? "no events" : "streaming"}{stats.lap > 0 && ` · lap ${stats.lap + 1}`}</span>
      </span>
      <span data-testid="readout">
        {stats.fps} fps · {stats.renders} message renders/s · {items} items · {stats.events} events · {stats.longTasks} long tasks{stats.heap === undefined ? "" : ` · ${Math.round(stats.heap / 1_000_000)} MB heap`}{lastAction && ` · ${lastAction}`}
      </span>
    </div>
  );
}

function Live() {
  const [input, setInput] = useState("");
  const [client, setClient] = useState<Awaited<ReturnType<typeof connectZeta>> | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; name?: string }>>([]);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  useEffect(() => { void discoverZeta().then((value) => { if (value) setInput(`#ws=${encodeURIComponent(value.url)}&token=${encodeURIComponent(value.controller_token)}`); }).catch(() => {}); }, []);
  const connect = async () => {
    const parsed = parseZetaUrl(input) ?? parseConnectFragment(input);
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
  const fallbackStore = useMemo(() => createRunStore(), []);
  const held = useMemo(() => client && session ? client.forSession(session) : null, [client, session]);
  useEffect(() => () => held?.release(), [held]);
  const store = held?.store ?? fallbackStore;
  const approve = (id: string) => void client?.request("approve", { session_id: session, request_id: id });
  const deny = (id: string) => void client?.request("deny", { session_id: session, request_id: id });
  const renderers: Renderers = {
    message: ({ id }) => <Message id={id} markdown={RichMarkdown} />,
    approval: ({ id }) => <Approval id={id} onApprove={approve} onDeny={deny} />,
  };
  return (
    <Shell page="playground">
      <div className="toolbar">
        <strong>live zeta</strong>
        <input aria-label="zeta websocket url" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ws://127.0.0.1:8765/ + token (or a #ws=...&token=... fragment)" />
        <button type="button" onClick={() => void connect()}>connect</button>
        <select aria-label="session" value={session ?? ""} onChange={(e) => setSession(e.target.value)}><option value="">session</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.name ?? item.id}</option>)}</select>
        {error && <span role="alert">{error}</span>}
      </div>
      <div className="scroll"><RunProvider store={store} highlight={highlight}><Timeline renderers={renderers} /></RunProvider></div>
      {client && session && <form className="toolbar composer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void client.request("send", { session_id: session, text }); setText(""); } }}><textarea aria-label="message" value={text} onChange={(e) => setText(e.target.value)} placeholder="send a message" /><button type="submit">send</button></form>}
    </Shell>
  );
}

function App() {
  const [live, setLive] = useState(false);
  const [source, setSource] = useState("zeta");
  const firstFixture = (nextSource: string) => Object.keys(fixtureSources[nextSource] ?? {})[0];
  const [mode, setMode] = useState(() => `zeta:${firstFixture("zeta")}`);
  const [speed, setSpeed] = useState(20);
  const [run, setRun] = useState(0);
  const store = useReplay(mode, speed, run);
  if (import.meta.env.DEV && live) return <Live />;
  const rate = mode === STRESS ? STRESS_RATE : speed;
  const label = mode === STRESS ? "stress" : mode.startsWith(STATIC) ? "static" : "replay";
  return (
    <RunProvider store={store} highlight={highlight}>
      <Shell page="playground">
        <div className="toolbar">
          <label className="field">
            source
            <select value={source} onChange={(e) => {
              const nextSource = e.target.value;
              setSource(nextSource);
              setMode(`${nextSource}:${firstFixture(nextSource)}`);
            }}>
              <option value="zeta">zeta</option>
              <option value="ai-sdk">ai-sdk</option>
            </select>
          </label>
          <label className="field">
            replay
            <select id="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              {Object.keys(fixtureSources[source] ?? {}).map((name) => (
                <option key={name} value={`${source}:${name}`}>{name}</option>
              ))}
              {source === "zeta" && <option value={STRESS}>stress: {STRESS_MESSAGES} messages + {STRESS_RATE} deltas/s</option>}
              {source === "zeta" && <option value={HUGE}>static: {HUGE_MESSAGES.toLocaleString("en")} messages</option>}
            </select>
          </label>
          <span className="field">
            <label htmlFor="rate">events/s</label>
            <input id="rate" type="range" min={1} max={200} value={rate} disabled={mode === STRESS || mode.startsWith(STATIC)} aria-valuetext={`${rate} events per second`} onChange={(e) => setSpeed(Number(e.target.value))} />
            <output htmlFor="rate">{mode.startsWith(STATIC) ? "-" : rate}</output>
          </span>
          <div className="group">
            <button type="button" onClick={() => setRun(run + 1)}>restart</button>
            {import.meta.env.DEV && <button type="button" onClick={() => setLive(true)}>live zeta</button>}
          </div>
        </div>
        <p className="caption">
          Replays loop with fresh ids; approvals pause them until answered. <strong>Unseen:</strong> scroll up and{" "}
          <strong>jump to latest (n)</strong> counts new rows; at the bottom, follow keeps up. <strong>Focus:</strong> tab into a row, then
          arrow keys. Anchoring: the virtual page.
        </p>
        <Status label={label} />
        <div className="scroll">
          <Timeline virtual renderers={renderers} />
        </div>
      </Shell>
    </RunProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
