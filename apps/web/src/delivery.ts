import type { ZetaClient } from "@fulcrum/zeta";

/** Zeta errors that mean the turn changed state between the click and the server: -32004 running, -32005 not running. */
const TURN_RUNNING = -32004;
const NO_TURN = -32005;
const DETAILS_EVICTED = -32010;
const code = (error: unknown) => (error as { code?: unknown } | null)?.code;

type Accepted = { accepted?: boolean; status?: string };

/**
 * Sends the composer's draft to zeta: `send` starts a turn, `steer` adds to the running one. With the negotiated
 * `delivery_id` feature every message carries an id, and a retry of the same text reuses it, so a retry after a timeout
 * or a dropped socket can never deliver the message twice (docs/serve-protocol.md, "client delivery IDs"). The id is
 * dropped once the server has accepted or definitely dropped the message, so the next message gets a fresh one. When
 * the turn starts or ends between the click and the server, the other method runs once with the same id.
 */
export function createDelivery(newId: () => string = () => `web-${crypto.randomUUID()}`) {
  let last: { text: string; id: string } | null = null;
  const request = async (client: ZetaClient, method: "send" | "steer", text: string, id: string | null) => {
    try {
      return (await client.request(method, { text, ...(id ? { delivery_id: id } : {}) }, { timeoutMs: 15_000 })) as Accepted;
    } catch (error) {
      // The id was accepted before, but the server no longer has its result: its outcome still says what happened.
      const outcome = (error as { data?: { outcome?: unknown } }).data?.outcome;
      if (code(error) === DETAILS_EVICTED) return { accepted: outcome !== "dropped", status: String(outcome) };
      throw error;
    }
  };
  return {
    async submit(client: ZetaClient, text: string, steer: boolean) {
      const id = client.features.includes("delivery_id") ? (last?.text === text ? last.id : newId()) : null;
      if (id) last = { text, id };
      let result: Accepted;
      try {
        result = await request(client, steer ? "steer" : "send", text, id);
      } catch (error) {
        const raced = steer ? code(error) === NO_TURN : code(error) === TURN_RUNNING;
        if (!raced) throw error;
        result = await request(client, steer ? "send" : "steer", text, id);
      }
      if (last?.id === id) last = null;
      if (result.accepted === false) throw new Error(result.status === "dropped" ? "the server dropped this message before the turn took it; send it again" : "the server did not accept this message");
    },
  };
}

/** Stops the running turn and everything it started (zeta's default session-scope abort). */
export const stopTurn = (client: ZetaClient) => client.request("abort", {}, { timeoutMs: 15_000 });
