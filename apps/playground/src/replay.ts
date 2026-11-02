import type { RunEvent } from "@fulcrum/core";

export type ReplayState = {
  budget: number;
  paused: boolean;
  elapsed: number;
  rate: number;
};

export function replayStep(nextEvent: () => RunEvent | undefined, state: ReplayState) {
  if (state.paused) return { ...state, events: [] as RunEvent[] };

  let budget = state.budget + (state.elapsed * state.rate) / 1000;
  let paused = false;
  const events: RunEvent[] = [];
  while (budget >= 1) {
    const event = nextEvent();
    if (!event) return { budget, paused, events, done: true };
    events.push(event);
    budget--;
    if (event.type === "approval_request") {
      paused = true;
      break;
    }
  }
  return { budget, paused, events, done: false };
}

// Every key that names an item, so a fixture replayed again adds new items instead of updating the old ones.
const ID_KEYS = new Set(["id", "message_id", "tool_call_id", "request_id", "notification_id", "childRunId"]);
export function relabel(event: RunEvent, lap: number): RunEvent {
  if (lap === 0) return event;
  return JSON.parse(JSON.stringify(event), (key, value) => (ID_KEYS.has(key) && typeof value === "string" ? `${value}~${lap}` : value));
}
