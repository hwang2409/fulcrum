import { useCallback, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMessageDelivered } from "./hooks.js";

/** What the user asked for when they submitted: steering a running turn, or a new message. */
export type ComposerIntent = { readonly steer: boolean };

type ComposerCallbacks = {
  /**
   * Delivers the draft. Resolve once the harness has accepted it; reject to keep the draft and show the error. It is
   * never called again while its promise is pending, and never with a blank draft.
   *
   * When the harness echoes sent messages into the run with a delivery id, call `trackDelivery(id)` with this send's
   * id (at any time before the promise settles). The send then counts as delivered at its first confirmation: the
   * promise resolving, or a user message with that id in the `RunProvider` store, whichever comes first. A rejection
   * after the echo is ignored, since the message reached the run. Without `trackDelivery`, only the promise counts.
   */
  onSubmit(text: string, intent: ComposerIntent, trackDelivery: (deliveryId: string) => void): Promise<unknown>;
  /** Stops the running turn. Shown only while a turn runs. A returned promise drives the pending and error states. */
  onStop?(): Promise<unknown> | void;
  /** The field's accessible name. */
  label?: string;
  placeholder?: string;
  /** The draft on mount. Give the composer a `key` (a session id, say) to start a different draft. */
  defaultValue?: string;
  className?: string;
};

/**
 * - `idle`: no turn runs; submit sends a new message.
 * - `steerable`: a turn runs and the harness accepts input into it; submit steers.
 * - `running`: a turn runs and the harness cannot take input until it ends. Submit is disabled (nothing is queued:
 *   the draft stays, and the user sends it once the turn ends or after stopping it).
 * - `read-only`: this view cannot act (an observer, a lost connection). The actions are hidden and `reason` says why;
 *   a draft stays on screen, read-only, and is kept for when the state changes back.
 */
export type ComposerState = "idle" | "running" | "steerable" | "read-only";
export type ComposerProps = ComposerCallbacks &
  ({ state: Exclude<ComposerState, "read-only">; reason?: never } | { state: "read-only"; reason: string });

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)) || "unknown error";

/**
 * The draft left after `sent` was accepted, given the draft `current` the user has now. Only the sent text leaves:
 * what they appended stays exactly as typed (blank lines and indentation included), and a draft they edited inside
 * the sent part stays whole, since none of it was sent as it reads now.
 */
export const unsentDraft = (current: string, sent: string) => (current.startsWith(sent) ? current.slice(sent.length) : current);

/** One submit in flight: the text it sent, and whether it already counts as delivered (the draft lost that text). */
type Send = { sent: string; delivered: boolean };

/** Runs a callback as a promise, so a synchronous throw takes the rejection path too. */
const attempt = (action: () => unknown) => new Promise<unknown>((resolve) => resolve(action()));

type Pending = { sending: boolean; stopping: boolean; error?: string; steer: boolean; state: ComposerState };
/** The status row: a live message while something is pending or failed, else the keyboard hint. */
const statusLine = ({ sending, stopping, error, steer, state }: Pending) => ({
  message: error ?? (stopping ? "stopping" : sending ? (steer ? "steering" : "sending") : ""),
  hint: state === "running" ? "a turn is running · stop it or wait to send" : steer ? "enter to steer the running turn · shift+enter for a new line" : "enter to send · shift+enter for a new line",
});

/**
 * The message box under a run. Keyboard: Enter submits, Shift+Enter adds a newline, and Enter never submits during
 * IME composition. The draft clears at the send's first confirmation (`onSubmit` resolves, or the run shows the
 * message's delivery id from `trackDelivery`), once, and only the part that was sent: text the user appended while it
 * was in flight stays exactly as typed, and a draft they rewrote stays whole (`unsentDraft`). A send without either
 * keeps the draft, so the host's retry of the same text can reuse its delivery id. The field is never disabled, so
 * focus and typing survive every state.
 */
export function Composer({ state, reason, onSubmit, onStop, label = "message", placeholder, defaultValue = "", className }: ComposerProps) {
  const id = useId();
  const [text, setText] = useState(defaultValue);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<{ kind: "submit" | "stop"; text: string }>();
  // Refs, not state, so a second click or key in the same frame sees the first one.
  const inFlight = useRef({ submit: false, stop: false });
  const input = useRef<HTMLTextAreaElement>(null);
  // The submit in flight and its tracked delivery id: the run's echo of that id confirms it before the reply does.
  const inFlightSend = useRef<Send | null>(null);
  const [deliveryId, setDeliveryId] = useState<string>();
  const echoed = useMessageDelivered(deliveryId);
  const delivered = useCallback((send: Send) => {
    if (send.delivered) return;
    send.delivered = true;
    setText((current) => unsentDraft(current, send.sent));
  }, []);
  // A layout effect, so the cleared draft paints in the same frame as the echoed row.
  useLayoutEffect(() => {
    if (echoed && inFlightSend.current) delivered(inFlightSend.current);
  }, [echoed, delivered]);
  const running = state === "running" || state === "steerable";
  const steer = state === "steerable";

  // A stop error is about a turn that has since ended.
  useLayoutEffect(() => {
    if (!running) setError((current) => (current?.kind === "stop" ? undefined : current));
  }, [running]);
  // The stop button goes away when the turn ends; if it had focus, focus moves to the field, not to the page. React
  // runs this cleanup before it removes the button, while the button still holds focus. Stable, so it runs only then.
  // When the whole form goes (read-only), the field goes with it: the read-only composer takes focus after the commit.
  const focusLost = useRef(false);
  const group = useRef<HTMLDivElement>(null);
  const stopRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      if (document.activeElement !== button) return;
      focusLost.current = true;
      input.current?.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    if (!focusLost.current) return;
    focusLost.current = false;
    if (!input.current?.isConnected) group.current?.focus({ preventScroll: true });
  });

  if (state === "read-only")
    return (
      <div ref={group} tabIndex={-1} className={className} data-part="composer" data-state="read-only" role="group" aria-label={label}>
        {text ? (
          <div data-part="composer-field" data-value={text}>
            <textarea rows={1} value={text} readOnly aria-label={`${label} (draft, read-only)`} />
          </div>
        ) : null}
        <p data-part="composer-reason">{reason}</p>
      </div>
    );

  const canSubmit = text.trim() !== "" && !sending && state !== "running";
  const submit = () => {
    if (inFlight.current.submit || !text.trim() || state === "running") return;
    inFlight.current.submit = true;
    const send: Send = { sent: text, delivered: false };
    inFlightSend.current = send;
    setSending(true);
    setError(undefined);
    const trackDelivery = (id: string) => { if (inFlightSend.current === send && !send.delivered) setDeliveryId(id); };
    attempt(() => onSubmit(send.sent, { steer }, trackDelivery))
      .then(
        () => delivered(send),
        (failure: unknown) => { if (!send.delivered) setError({ kind: "submit", text: `could not ${steer ? "steer" : "send"}: ${errorText(failure)}` }); },
      )
      .finally(() => { inFlight.current.submit = false; inFlightSend.current = null; setDeliveryId(undefined); setSending(false); });
  };
  const stop = () => {
    if (inFlight.current.stop || !onStop) return;
    inFlight.current.stop = true;
    setStopping(true);
    setError(undefined);
    attempt(onStop)
      .catch((failure: unknown) => setError({ kind: "stop", text: `could not stop: ${errorText(failure)}` }))
      .finally(() => { inFlight.current.stop = false; setStopping(false); });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };
  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    // The click moved focus to the button; give it back to the field without scrolling the page to it.
    input.current?.focus({ preventScroll: true });
    submit();
  };

  const { message, hint } = statusLine({ sending, stopping, error: error?.text, steer, state });
  return (
    <form
      className={className}
      data-part="composer"
      data-state={state}
      data-error={error?.kind}
      data-pending={sending ? "submit" : stopping ? "stop" : undefined}
      aria-label={label}
      aria-busy={sending || stopping || undefined}
      onSubmit={onFormSubmit}
    >
      <div data-part="composer-field" data-value={text}>
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={`${id}-hint ${id}-message`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div data-part="composer-bar">
        <p data-part="composer-status" data-tone={error ? "danger" : message ? "busy" : undefined} title={error?.text}>
          <span data-part="composer-hint" id={`${id}-hint`} hidden={Boolean(message)}>{hint}</span>
          <span data-part="composer-message" id={`${id}-message`} role="status">{message}</span>
        </p>
        {running && onStop ? (
          <button ref={stopRef} type="button" data-part="composer-stop" data-action="stop" aria-label="stop the running turn" aria-disabled={stopping || undefined} onClick={stop}>
            {stopping ? "stopping" : "stop"}
          </button>
        ) : null}
        <button
          type="submit"
          data-part="composer-submit"
          data-action={steer ? "steer" : "send"}
          aria-label={steer ? "steer the running turn" : "send message"}
          aria-disabled={!canSubmit || undefined}
        >
          {steer ? "steer" : "send"}
        </button>
      </div>
    </form>
  );
}
