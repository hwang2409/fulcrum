import { memo } from "react";
import { useItem } from "./hooks.js";
import { boundText, clipSummary, MAX_SUMMARY_CHARS } from "./tools/common.js";

// A notification's data has no fixed shape. Only these keys are read, and only string (or, for time, finite number)
// values count: nested objects, arrays, and every other key stay unread, so an adapter's private payload never renders.
const TEXT_KEYS = ["text", "message", "summary", "title", "preview", "description", "content"];
const KIND_KEYS = ["kind", "type"];
const STATUS_KEYS = ["status", "level"];
const TIME_KEYS = ["timestamp", "time", "created_at"];
const MAX_FACT_CHARS = 120;
// The opened text is for reading, not a log viewer: past this the row says how much it shows.
const MAX_TEXT_CHARS = 10_000;

type Data = Record<string, unknown> | undefined;

// Data from a host may hold getters or proxies; a read that throws counts as absent.
const read = (data: Data, key: string): unknown => {
  try {
    return data?.[key];
  } catch {
    return undefined;
  }
};
const firstString = (data: Data, keys: string[]) => {
  for (const key of keys) {
    const value = read(data, key);
    if (typeof value === "string" && value.trim()) return value;
  }
};
const line = (value: string, limit: number) => clipSummary(value.replace(/\s+/g, " ").trim(), limit);
const timeOf = (data: Data) => {
  for (const key of TIME_KEYS) {
    const value = read(data, key);
    // A number is seconds since the epoch when its magnitude is below 1e11 (1e11 s is the year 5138), else milliseconds.
    // shortcut: so millisecond values before 1973-03-03 (1e11 ms) read as seconds; pass an ISO string for such dates.
    const ms = typeof value === "number" && Number.isFinite(value) ? (Math.abs(value) < 1e11 ? value * 1_000 : value) : typeof value === "string" ? Date.parse(value) : Number.NaN;
    const date = new Date(ms);
    // The row shows the local clock time only; the full instant stays in `iso` (the `<time>` datetime and title).
    if (Number.isFinite(date.getTime())) return { iso: date.toISOString(), label: date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) };
  }
};

/** The first text field of a notification's data (`text`, `message`, `summary`, `title`, `preview`, `description`, `content`). */
export const notificationText = (data: Data) => firstString(data, TEXT_KEYS);

/**
 * What a notification row shows, derived from its data alone. `summary` is one bounded line; `text` is the full text
 * (bounded) when the summary cut or flattened it. Each field is present only when the data holds a usable string.
 * `time.label` is the local clock time (hour and minute); `time.iso` is the full instant.
 */
export type NotificationModel = {
  readonly summary: string;
  readonly text?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly time?: { readonly iso: string; readonly label: string };
};

export function notificationModel(data: Data): NotificationModel {
  const full = notificationText(data);
  const first = full?.split("\n").find((part) => part.trim());
  const summary = first ? line(first, MAX_SUMMARY_CHARS) : "notification";
  const kind = firstString(data, KIND_KEYS);
  const status = firstString(data, STATUS_KEYS);
  return {
    summary,
    text: full && full.replace(/\s+/g, " ").trim() !== summary ? boundText(full, MAX_TEXT_CHARS).text : undefined,
    kind: kind ? line(kind, MAX_FACT_CHARS) : undefined,
    status: status ? line(status, MAX_FACT_CHARS) : undefined,
    time: timeOf(data),
  };
}

/**
 * A notification: one quiet line that says what it says. When its data also names a kind, status, or time, or the
 * line cut its text, the row is a disclosure whose summary is that line and whose body lists those facts.
 */
export const Notification = memo(function Notification({ id, className }: { id: string; className?: string }) {
  const item = useItem(id);
  if (item?.type !== "notification" || item.event.type !== "notification") return null;
  const model = notificationModel(item.event.data);
  const attributes = { className, "aria-label": "notification", "data-part": "notification", "data-kind": "notification", "data-id": id, "data-status": model.status };
  if (!model.text && !model.kind && !model.status && !model.time) {
    return <div {...attributes} role="group"><span data-part="notification-summary"><span data-part="notification-line">{model.summary}</span></span></div>;
  }
  return (
    <details {...attributes}>
      <summary data-part="notification-summary"><span data-part="notification-line">{model.summary}</span></summary>
      <div data-part="notification-body">
        {model.kind || model.status || model.time ? (
          <dl data-part="notification-meta">
            {model.kind ? <><dt>kind</dt><dd data-fact="kind">{model.kind}</dd></> : null}
            {model.status ? <><dt>status</dt><dd data-fact="status">{model.status}</dd></> : null}
            {model.time ? <><dt>time</dt><dd data-fact="time"><time dateTime={model.time.iso} title={model.time.iso}>{model.time.label}</time></dd></> : null}
          </dl>
        ) : null}
        {model.text ? <div data-part="notification-text">{model.text}</div> : null}
      </div>
    </details>
  );
});
