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
