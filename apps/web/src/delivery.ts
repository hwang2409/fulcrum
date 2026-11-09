import type { RunEvent } from "@fulcrum/core";
import type { SessionStore, ZetaClient } from "@fulcrum/zeta";

/** Zeta errors that mean the turn changed state between the click and the server: -32004 running, -32005 not running. */
const TURN_RUNNING = -32004;
const NO_TURN = -32005;
const DETAILS_EVICTED = -32010;
const LIVE_STATUS_WAIT_MS = 1_000;
const code = (error: unknown) => (error as { code?: unknown } | null)?.code;

type Accepted = { accepted?: boolean; status?: string };
type DeliveryOutcome = "delivered" | "dropped" | "unknown";
export type DeliveryNotice = { intent: string; outcome: Exclude<DeliveryOutcome, "delivered"> };

/** Zeta's closed delivery outcomes. A newer or malformed value is unconfirmed, never accepted. */
const deliveryOutcome = (value: unknown): DeliveryOutcome => value === "delivered" || value === "dropped" ? value : "unknown";

/** One message the user asked for. `intent` names it for its whole life; `id` names one attempt to deliver it. */
type Message = { text: string; intent: string; id: string | null };
type Method = "send" | "steer";

/** Whether the turn changed state between the click and the server, so the other method should run instead. */
const raced = (method: Method, error: unknown) => code(error) === (method === "steer" ? NO_TURN : TURN_RUNNING);
const refusal = (result: Accepted) => new Error(result.status === "dropped" ? "the server dropped this message before the turn took it; send it again" : "the server did not accept this message");

/**
 * Sends the composer's draft to zeta: `send` starts a turn, `steer` adds to the running one. With the negotiated
 * `delivery_id` feature every attempt carries an id, and a retry of the same text reuses it, so a retry after a timeout
 * or a dropped socket can never deliver the message twice (docs/serve-protocol.md, "client delivery IDs"). The id is
 * dropped once the server has accepted or definitely dropped the message, so the next message gets a fresh one. When
 * the turn starts or ends between the click and the server, the other method runs once with the same id.
 *
 * Zeta delivers a steer at the next provider boundary of the running turn. A turn that ends first (a final answer with
 * no tool call) drops it, and the protocol leaves the resend to the client. `turnEnded` does that, as the zeta TUI does:
 * each dropped steer goes out again as a new message, in order, with a new delivery id. After a stop the user meant to
 * drop them, so they stay dropped, and `turnEnded` names them so the view can show they never reached the agent.
 *
 * Each message keeps one `intent` across every attempt, and the client stamps it on zeta's `user_message` echo, so the
 * steer's row becomes the resent message's row: the user sees one row per message they wrote.
 */
export function createDelivery(newId: () => string = () => `web-${crypto.randomUUID()}`, reconcile?: (event: RunEvent) => void, store?: SessionStore) {
  let unsettled: Message | null = null;
  let steers: Message[] = [];
  // The user's stop of the running turn: resolves to whether it ended the turn (it failed, or found no turn: false).
  let stopping: Promise<boolean> | null = null;
  const request = async (client: ZetaClient, method: Method, { text, id, intent }: Message) => {
    try {
      return (await client.request(method, { text, ...(id ? { delivery_id: id } : {}) }, { timeoutMs: 15_000, intent })) as Accepted;
    } catch (error) {
      // The id was accepted before, but the server no longer has its result: its outcome still says what happened.
      if (code(error) === DETAILS_EVICTED) {
        const outcome = deliveryOutcome((error as { data?: { outcome?: unknown } }).data?.outcome);
        return { accepted: outcome === "delivered", status: outcome };
      }
      throw error;
    }
  };
  /** Delivers one attempt; a steer that zeta queued is remembered, since the turn may still drop it. */
  const deliver = async (client: ZetaClient, method: Method, message: Message) => {
    let used = method;
    let result: Accepted;
    try {
      result = await request(client, method, message);
    } catch (error) {
      if (!raced(method, error)) throw error;
      used = method === "steer" ? "send" : "steer";
      result = await request(client, used, message);
    }
    if (used === "steer" && message.id && result.accepted !== false) steers.push(message);
    return { result, used };
  };
  const reconcileAccepted = (message: Message, used: Method, result: Accepted) => {
    if (result.accepted === true && message.id && reconcile)
      reconcile({ type: "user_message", text: message.text, mode: used, intent: message.intent, delivery_id: message.id });
  };
  const fresh = (client: ZetaClient, text: string): Message => {
    const intent = newId();
    return { text, intent, id: client.features.includes("delivery_id") ? intent : null };
  };
  /** The live delivery status on the message's row: the row has its intent's id, or its delivery id's when zeta's echo came first. */
  const liveStatus = (live: SessionStore, { intent, id }: Message): DeliveryOutcome | undefined => {
    for (const itemId of [`user:intent:${intent}`, `user:delivery:${id}`]) {
      const item = live.getItem(itemId);
      if (item?.type === "user" && item.event.type === "user_message" && item.event.delivery_id === id && item.event.delivery_status) return deliveryOutcome(item.event.delivery_status);
    }
    return undefined;
  };
  // Checks of messages that wait for their live status. The store listener exists only while one waits.
  const waiting = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  const waitForLiveStatus = (live: SessionStore, message: Message) => new Promise<DeliveryOutcome | undefined>((resolve) => {
    const check = () => { const status = liveStatus(live, message); if (status !== undefined) finish(status); };
    const finish = (value: DeliveryOutcome | undefined) => {
      clearTimeout(timer);
      waiting.delete(check);
      if (!waiting.size) { unsubscribe?.(); unsubscribe = null; }
      resolve(value);
    };
    // Zeta sends a drop before the turn's end, so the status is normally on the row before this wait ends.
    const timer = setTimeout(() => finish(undefined), LIVE_STATUS_WAIT_MS);
    waiting.add(check);
    unsubscribe ??= live.subscribe(() => [...waiting].forEach((waiter) => waiter()));
  });
  const queryStatus = async (client: ZetaClient, message: Message) => {
    const { status, outcome } = (await client.request("delivery_status", { delivery_id: message.id }, { timeoutMs: 15_000 })) as { status?: unknown; outcome?: unknown };
    return deliveryOutcome(status === "evicted" ? outcome : status);
  };
  const finalOutcome = async (client: ZetaClient, message: Message) => {
    if (!store || !client.features.includes("delivery_id") || !client.features.includes("session_history_fidelity")) return queryStatus(client, message);
    const live = liveStatus(store, message) ?? await waitForLiveStatus(store, message);
    // No live status: a restart snapshot may have rebuilt the store and lost the row the drop would mark, so ask zeta.
    return live ?? queryStatus(client, message);
  };
  return {
    /** `trackDelivery` gets the attempt's delivery id, so the composer can clear its draft at zeta's echo of it. */
    async submit(client: ZetaClient, text: string, steer: boolean, trackDelivery?: (deliveryId: string) => void) {
      const message = unsettled?.text === text ? unsettled : fresh(client, text);
      unsettled = message;
      if (message.id) trackDelivery?.(message.id);
      let delivered: Awaited<ReturnType<typeof deliver>>;
      try {
        delivered = await deliver(client, steer ? "steer" : "send", message);
      } catch (error) {
        // zeta echoed this id into the run, so it took the message: a later message with the same text needs a new id.
        if (message.id && store?.hasMessageDelivery(message.id)) unsettled = null;
        throw error;
      }
      if (delivered.result.accepted === false) throw refusal(delivered.result);
      unsettled = null;
      reconcileAccepted(message, delivered.used, delivered.result);
    },
    /** Stops the running turn (zeta's default session-scope abort); `turnEnded` then knows the user ended it. */
    stop(client: ZetaClient) {
      const request = stopTurn(client);
      stopping = request.then((result) => (result as { aborted?: boolean } | null)?.aborted !== false, () => false);
      return request;
    },
    /**
     * Call when the running turn ends. Resends the steers it dropped, unless the user's stop ended it: then they stay
     * dropped, and notices are returned so the view can mark those rows. An unknown outcome is not resent and returns
     * a not-confirmed notice. A stop that failed or found no turn is not a stop, so its dropped steers are resent.
     */
    async turnEnded(client: ZetaClient) {
      const ended = steers;
      steers = [];
      const stopped = await (stopping ?? false);
      stopping = null;
      const notices: DeliveryNotice[] = [];
      // A query that fails (a dropped socket) leaves its steer unmarked, the safe side; the others still count.
      const statuses = await Promise.allSettled(ended.map((message) => finalOutcome(client, message)));
      for (const [index, message] of ended.entries()) {
        const status = statuses[index]!;
        if (status.status === "rejected" || status.value === "delivered") continue;
        if (status.value === "unknown") { notices.push({ intent: message.intent, outcome: "unknown" }); continue; }
        if (stopped) { notices.push({ intent: message.intent, outcome: "dropped" }); continue; }
        const retry = { ...message, id: newId() };
        const delivered = await deliver(client, "send", retry);
        if (delivered.result.accepted === false) throw refusal(delivered.result);
        reconcileAccepted(retry, delivered.used, delivered.result);
      }
      return notices;
    },
  };
}

/** Stops the running turn and everything it started (zeta's default session-scope abort). */
export const stopTurn = (client: ZetaClient) => client.request("abort", {}, { timeoutMs: 15_000 });
