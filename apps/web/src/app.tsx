import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type MarkdownProps } from "@fulcrum/markdown/react";
import { Approval, Message, RunProvider, Timeline, useRun, type Renderers } from "@fulcrum/react";
import type { ZetaClient } from "@fulcrum/zeta";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { createConnection, type Connection, type ConnectionState } from "./connection";
import { ago, createSessions, sessionTitle, topLevel, type SessionMeta, type Sessions, type SessionsState } from "./session";
import { ThemePicker, useTheme } from "./theme";

const highlight = createHighlighter();
addEventListener("pagehide", () => highlight.dispose(), { once: true });
const RichMarkdown = (props: MarkdownProps) => <Markdown {...props} highlight={highlight} />;

/** The command that starts a server this page may connect to. The origin is exact: localhost and 127.0.0.1 differ. */
export const serveCommand = (origin: string) => `zeta serve --ws 8765 --ws-origin ${origin}`;

// Renderers stay module-level so appends never re-render every row; approvals reach the live client through context.
type Decide = (requestId: string) => Promise<unknown>;
const Decisions = createContext<{ approve?: Decide; deny?: Decide; disabledReason?: string } | null>(null);
function ZetaApproval({ id }: { id: string }) {
  const decide = useContext(Decisions);
  return <Approval id={id} onApprove={decide?.approve} onDeny={decide?.deny} disabledReason={decide?.disabledReason} />;
}
const renderers: Renderers = {
  message: ({ id }) => <Message id={id} markdown={RichMarkdown} />,
  approval: ZetaApproval,
};

const useExternal = <T,>(source: { subscribe(listener: () => void): () => void; readonly state: T }) =>
  useSyncExternalStore(useCallback((listener) => source.subscribe(listener), [source]), () => source.state);

/** Seconds until `at`, ticking once a second only while a wait is shown. */
function useCountdown(at: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

const hashSession = () => new URLSearchParams(location.hash.slice(1)).get("session");

export function App() {
  const [theme, setTheme] = useTheme();
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const sessions = useMemo(
    () => createSessions(connection, {
      selected: hashSession(),
      onSelect: (id) => history.replaceState(null, "", `#session=${encodeURIComponent(id)}`),
    }),
    [connection],
  );
  useEffect(() => () => { sessions.dispose(); connection.stop(); }, [connection, sessions]);
  const state = useExternal(connection);
  const view = useExternal(sessions);
  const [drawer, setDrawer] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const closeDrawer = useCallback(() => { returnFocus.current = true; setDrawer(false); }, []);
  // After the render that drops `inert` from main, so the menu button can take focus again.
  useEffect(() => { if (!drawer && returnFocus.current) { returnFocus.current = false; menu.current?.focus(); } }, [drawer]);
  const select = useCallback((id: string) => { sessions.select(id); setDrawer(false); }, [sessions]);
  const current = view.sessions.find((session) => session.session_id === (view.open?.id ?? view.selected));
  useEffect(() => { document.title = current ? `${sessionTitle(current)} · zeta` : "zeta · fulcrum"; }, [current]);

  return (
    <div className="app" data-drawer={drawer ? "open" : "closed"}>
      <Sidebar
        state={state}
        view={view}
        sessions={sessions}
        onSelect={select}
        open={drawer}
        onClose={closeDrawer}
        footer={<ThemePicker theme={theme} onChange={setTheme} />}
      />
      {drawer ? <button type="button" className="scrim" aria-label="close sessions" tabIndex={-1} onClick={closeDrawer} /> : null}
      <main className="main" inert={drawer || undefined}>
        <header className="topbar">
          <button ref={menu} type="button" className="menu" aria-label="sessions" aria-expanded={drawer} aria-controls="sessions" onClick={() => setDrawer(true)}>
            <span aria-hidden="true" className="menu-icon" />
          </button>
          <RunTitle session={current} view={view} />
        </header>
        <Body state={state} view={view} connection={connection} sessions={sessions} onOpenDrawer={() => setDrawer(true)} />
      </main>
    </div>
  );
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const [word, tone] =
    state.phase === "connected" ? ["connected", "ok"]
    : state.phase === "connecting" ? [state.lost ? "reconnecting" : "connecting", "busy"]
    : state.phase === "dropped" ? ["connection lost", "danger"]
    : state.phase === "not_running" ? ["not running", "danger"]
    : state.phase === "auth_failed" ? ["auth failed", "danger"]
    : state.phase === "busy" ? ["in use", "warn"]
    : ["unsupported", "danger"];
  return <span className="badge" data-tone={tone} role="status">{word}</span>;
}

function Sidebar({ state, view, sessions, onSelect, open, onClose, footer }: {
  state: ConnectionState; view: SessionsState; sessions: Sessions; onSelect(id: string): void; open: boolean; onClose(): void; footer: ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);
  const rows = useMemo(() => topLevel(view.sessions), [view.sessions]);
  const selected = view.open?.id ?? view.selected;
  // The drawer takes focus when it opens, on the session on screen.
  useEffect(() => {
    if (!open) return;
    (list.current?.querySelector<HTMLElement>("[tabindex='0']") ?? list.current?.closest("aside")?.querySelector<HTMLElement>("button"))?.focus();
  }, [open]);
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && open) { event.preventDefault(); onClose(); return; }
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button.session") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  };
  const focusable = rows.some((row) => row.session_id === selected) ? selected : rows[0]?.session_id;
  const now = Date.now();
  return (
    <aside id="sessions" className="sidebar" onKeyDown={onKey} role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label="sessions">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">zeta</span>
        <span className="brand-sub">fulcrum</span>
        <ConnectionBadge state={state} />
      </div>
      <div className="list-head">
        <h2>sessions</h2>
        <span className="count">{rows.length ? rows.length : ""}</span>
        <button type="button" className="ghost" onClick={() => void sessions.refresh()} disabled={state.phase !== "connected"}>refresh</button>
      </div>
      <nav className="list" aria-label="sessions">
        {view.listError ? <p className="note" data-tone="danger">could not list sessions: {view.listError}</p> : null}
        {state.phase === "connected" && !rows.length && !view.listError ? <p className="note">no sessions yet. start one in zeta.</p> : null}
        <ul ref={list}>
          {rows.map((session) => (
            <SessionRow key={session.session_id} session={session} now={now} selected={session.session_id === selected} focusable={session.session_id === focusable} server={view.server} onSelect={onSelect} />
          ))}
        </ul>
        {view.nextOffset !== null ? <button type="button" className="ghost more" onClick={() => void sessions.loadMore()}>load more sessions</button> : null}
      </nav>
      <div className="sidebar-foot">{footer}</div>
    </aside>
  );
}

function SessionRow({ session, now, selected, focusable, server, onSelect }: {
  session: SessionMeta; now: number; selected: boolean; focusable: boolean; server: SessionsState["server"]; onSelect(id: string): void;
}) {
  const live = server?.id === session.session_id;
  const status = !live ? null : server.approvals ? "approval" : server.state === "idle" ? "open" : "running";
  return (
    <li>
      <button type="button" className="session" aria-current={selected ? "true" : undefined} tabIndex={focusable ? 0 : -1} onClick={() => onSelect(session.session_id)}>
        <span className="session-title">{sessionTitle(session)}</span>
        <span className="session-meta">
          <time dateTime={session.updated_at} title={new Date(session.updated_at).toLocaleString()}>{ago(session.updated_at, now)}</time>
          {status ? <span className="state" data-status={status}>{status === "approval" ? "needs approval" : status}</span> : null}
          {session.model ? <span className="model">{session.model}</span> : null}
        </span>
      </button>
    </li>
  );
}

function RunTitle({ session, view }: { session: SessionMeta | undefined; view: SessionsState }) {
  if (!session) return <div className="run-title"><h1>{view.selected ? "session" : "zeta"}</h1></div>;
  return (
    <div className="run-title">
      <h1 title={sessionTitle(session)}>{sessionTitle(session)}</h1>
      <p className="run-meta">
        {view.open?.id === session.session_id && !view.open.stale ? (
          <RunProvider store={view.open.lease.store}><RunStatus /></RunProvider>
        ) : null}
        {session.model ? <span>{session.model}</span> : null}
        {session.cwd ? <span className="cwd" title={session.cwd}>{session.cwd.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~")}</span> : null}
      </p>
    </div>
  );
}

function RunStatus() {
  const agent = useRun((state) => state.agent);
  return <span className="state" data-status={agent === "running" ? "running" : "idle"}>{agent === "running" ? "running" : "idle"}</span>;
}

/** Refreshes the list when a run ends, so times and titles stay current without polling. */
function RefreshOnIdle({ sessions }: { sessions: Sessions }) {
  const agent = useRun((state) => state.agent);
  const prior = useRef(agent);
  useEffect(() => {
    if (prior.current === "running" && agent !== "running") void sessions.refresh();
    prior.current = agent;
  }, [agent, sessions]);
  return null;
}

function Body({ state, view, connection, sessions, onOpenDrawer }: { state: ConnectionState; view: SessionsState; connection: Connection; sessions: Sessions; onOpenDrawer(): void }) {
  const offline = state.phase !== "connected";
  if (view.open) {
    return (
      <>
        {offline ? <ConnectionNotice state={state} connection={connection} compact /> : null}
        <Run client={offline ? null : connection.client} sessions={sessions} open={view.open} />
      </>
    );
  }
  if (offline) return <ConnectionNotice state={state} connection={connection} />;
  if (view.opening) {
    const session = view.sessions.find((item) => item.session_id === view.opening!.id);
    return (
      <Panel title={`opening ${session ? sessionTitle(session) : "session"}`} tone="busy">
        <p>loading history{view.opening.messages ? ` · ${view.opening.messages.toLocaleString("en")} messages` : ""}</p>
      </Panel>
    );
  }
  if (view.openError) {
    const running = view.server?.id && view.server.id !== view.openError.id ? view.server.id : null;
    return view.openError.busy ? (
      <Panel title="zeta is busy with another session" tone="warn">
        <p>zeta serve opens a session only when no turn runs. wait for the running turn to end, or open the running session.</p>
        <div className="actions">
          {running ? <button type="button" className="primary" onClick={() => sessions.select(running)}>open the running session</button> : null}
          <button type="button" className="ghost" onClick={() => sessions.select(view.openError!.id)}>try again</button>
        </div>
      </Panel>
    ) : (
      <Panel title="could not open this session" tone="danger">
        <p className="mono">{view.openError.message}</p>
        <div className="actions"><button type="button" className="primary" onClick={() => sessions.select(view.openError!.id)}>try again</button></div>
      </Panel>
    );
  }
  return (
    <Panel title="choose a session">
      <p>{view.sessions.length ? "pick a session from the list to follow its run." : "this zeta has no sessions yet."}</p>
      <div className="actions only-narrow"><button type="button" className="primary" onClick={onOpenDrawer}>show sessions</button></div>
    </Panel>
  );
}

function Run({ client, sessions, open }: { client: ZetaClient | null; sessions: Sessions; open: NonNullable<SessionsState["open"]> }) {
  const scroll = useRef<HTMLDivElement>(null);
  const decisions = useMemo(() => {
    if (!client || open.stale) return { disabledReason: "reconnecting — decisions are disabled until the server confirms this session" };
    const decide = (method: "approve" | "deny"): Decide => (request_id) => client.request(method, { request_id }, { timeoutMs: 15_000 });
    return { approve: decide("approve"), deny: decide("deny") };
  }, [client, open.stale]);
  useLayoutEffect(() => { scroll.current?.focus({ preventScroll: true }); }, [open.lease.store]);
  return (
    <Decisions.Provider value={decisions}>
      <RunProvider store={open.lease.store}>
        <RefreshOnIdle sessions={sessions} />
        <div ref={scroll} className="scroll" tabIndex={-1} data-stale={open.stale || undefined}>
          <Timeline renderers={renderers} virtual scrollRef={scroll} aria-label="session activity" />
        </div>
      </RunProvider>
    </Decisions.Provider>
  );
}

function Panel({ title, tone, children }: { title: string; tone?: string; children: ReactNode }) {
  return (
    <section className="panel" data-tone={tone} aria-labelledby="panel-title">
      <h2 id="panel-title">{title}</h2>
      {children}
    </section>
  );
}

function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return (
    <div className="command">
      <code>{value}</code>
      <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true))}>
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function ConnectionNotice({ state, connection, compact = false }: { state: ConnectionState; connection: Connection; compact?: boolean }) {
  const wait = useCountdown("retryAt" in state ? state.retryAt : null);
  const command = serveCommand(location.origin);
  const retry = wait === null ? null : (
    <div className="actions">
      <span className="wait" aria-live="off">{wait > 0 ? `retrying in ${wait}s` : "retrying"}</span>
      <button type="button" className="primary" onClick={() => connection.retryNow()}>retry now</button>
    </div>
  );
  const lost = "lost" in state && state.lost;
  let title: string;
  let tone = "danger";
  let body: ReactNode;
  switch (state.phase) {
    case "connected":
      return null;
    case "connecting":
      title = lost ? "reconnecting to zeta serve" : "connecting to zeta serve";
      tone = "busy";
      body = <p>looking for the server through this dev server's handoff.</p>;
      break;
    case "dropped":
      title = "connection lost";
      body = <p>the socket to zeta serve closed. the run keeps going on the server; this page reconnects and rebuilds the session from its history.</p>;
      break;
    case "not_running":
      title = lost ? "connection lost: zeta serve stopped" : "zeta serve is not running";
      body = (
        <>
          <p>start it with this page's origin in the allowlist. this page connects as soon as it is up.</p>
          <Copy value={command} />
        </>
      );
      break;
    case "auth_failed":
      title = "auth failed";
      body = state.reason === "origin" ? (
        <>
          <p>zeta serve allows {state.origins.map((origin, index) => <span key={origin}>{index ? ", " : ""}<code>{origin}</code></span>)}, not this page's origin <code>{location.origin}</code>. restart it with this origin:</p>
          <Copy value={command} />
        </>
      ) : (
        <>
          <p>zeta serve is running but refused the token. restart it so the dev server hands over a fresh token:</p>
          <Copy value={command} />
        </>
      );
      break;
    case "busy":
      title = "zeta serve is in use";
      tone = "warn";
      body = <p>zeta serve accepts one client at a time. close the other client (another tab, the playground, or the zeta app) and this page takes over.</p>;
      break;
    case "incompatible":
      title = "unsupported protocol version";
      body = <p>this zeta does not speak protocol 1.0 to 1.2. update zeta or fulcrum, then reload.</p>;
      break;
  }
  if (compact) {
    return (
      <div className="notice" data-tone={tone} role="status">
        <strong>{title}</strong>
        <span className="wait">{wait === null ? "" : wait > 0 ? `retrying in ${wait}s` : "retrying"}</span>
        {wait !== null ? <button type="button" className="ghost" onClick={() => connection.retryNow()}>retry now</button> : null}
        {state.phase === "not_running" || state.phase === "auth_failed" ? <Copy value={command} /> : null}
      </div>
    );
  }
  return (
    <Panel title={title} tone={tone}>
      {body}
      {retry}
    </Panel>
  );
}
