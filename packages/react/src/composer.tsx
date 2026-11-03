import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

/** What the user asked for when they submitted: steering a running turn, or a new message. */
export type ComposerIntent = { readonly steer: boolean };

type ComposerCallbacks = {
  /**
   * Delivers the draft. Resolve once the harness has accepted it; reject to keep the draft and show the error. It is
   * never called again while its promise is pending, and never with a blank draft.
   */
  onSubmit(text: string, intent: ComposerIntent): Promise<unknown>;
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
 * - `read-only`: this view cannot act (an observer, a lost connection). The field and actions are hidden and `reason`
 *   says why; the draft is kept for when the state changes back.
 */
export type ComposerState = "idle" | "running" | "steerable" | "read-only";
export type ComposerProps = ComposerCallbacks &
  ({ state: Exclude<ComposerState, "read-only">; reason?: never } | { state: "read-only"; reason: string });

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)) || "unknown error";

/**
 * The message box under a run. Keyboard: Enter submits, Shift+Enter adds a newline, and Enter never submits during
 * IME composition. The draft clears only when `onSubmit` resolves, and only the part that was sent: text the user
 * appended while it was in flight stays, and a draft they rewrote stays whole. The field is never disabled, so focus
 * and typing survive every state.
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
  const running = state === "running" || state === "steerable";
  const steer = state === "steerable";

  // A stop error is about a turn that has since ended.
  useLayoutEffect(() => {
    if (!running) setError((current) => (current?.kind === "stop" ? undefined : current));
  }, [running]);

  if (state === "read-only")
    return (
      <div className={className} data-part="composer" data-state="read-only" role="group" aria-label={label}>
        <p data-part="composer-reason">{reason}</p>
      </div>
    );

  const canSubmit = text.trim() !== "" && !sending && state !== "running";
  const submit = () => {
    if (inFlight.current.submit || !text.trim() || state === "running") return;
    inFlight.current.submit = true;
    const sent = text;
    setSending(true);
    setError(undefined);
    const done = () => { inFlight.current.submit = false; setSending(false); };
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(onSubmit(sent, { steer }));
    } catch (thrown) {
      result = Promise.reject(thrown);
    }
    result.then(
      () => {
        done();
        setText((current) => (current === sent ? "" : current.startsWith(sent) ? current.slice(sent.length).replace(/^\s+/, "") : current));
      },
      (failure: unknown) => {
        done();
        setError({ kind: "submit", text: `could not ${steer ? "steer" : "send"}: ${errorText(failure)}` });
      },
    );
  };
  const stop = () => {
    if (inFlight.current.stop || !onStop) return;
    inFlight.current.stop = true;
    setStopping(true);
    setError(undefined);
    const done = () => { inFlight.current.stop = false; setStopping(false); };
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(onStop());
    } catch (thrown) {
      result = Promise.reject(thrown);
    }
    result.then(done, (failure: unknown) => {
      done();
      setError({ kind: "stop", text: `could not stop: ${errorText(failure)}` });
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };
  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    input.current?.focus();
    submit();
  };

  const message = error?.text ?? (stopping ? "stopping" : sending ? (steer ? "steering" : "sending") : "");
  const hint = state === "running" ? "a turn is running · stop it or wait to send" : steer ? "enter to steer the running turn · shift+enter for a new line" : "enter to send · shift+enter for a new line";
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
        <p data-part="composer-status" data-tone={error ? "danger" : message ? "busy" : undefined}>
          <span data-part="composer-hint" id={`${id}-hint`} hidden={Boolean(message)}>{hint}</span>
          <span data-part="composer-message" id={`${id}-message`} role="status">{message}</span>
        </p>
        {running && onStop ? (
          <button type="button" data-part="composer-stop" data-action="stop" aria-label="stop the running turn" aria-disabled={stopping || undefined} onClick={stop}>
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
