import { expect, test } from "bun:test";
import * as parts from "@fulcrum/react";
import { createRunStore, type RunEndOutcome } from "@fulcrum/core";
import type { RunStatusValue } from "@fulcrum/react";
import { codeDemos } from "../src/gallery/code-demos";
import { composerDemos } from "../src/gallery/composer-demos";
import { demos } from "../src/gallery/demos";

test("every exported part of @fulcrum/react has a gallery demo", () => {
  // Components are the capitalized value exports; the providers (RunProvider, HighlightContext) wrap demos, so they need
  // none of their own. Tool bodies render inside ToolCall and Approval, so each needs a demo call with its view kind
  // (generic: no view).
  const components = Object.keys(parts).filter((name) => /^[A-Z]/.test(name) && name !== "RunProvider" && name !== "HighlightContext");
  const bodies = components.filter((name) => name.endsWith("Body") && name !== "ToolBody");
  const parents = components.filter((name) => !name.endsWith("Body"));
  const shown = new Set([...demos, ...composerDemos, ...codeDemos].map((demo) => demo.part));
  const kinds = new Set(
    demos.flatMap((demo) => demo.events.flatMap((event) => (event.type === "tool_start" || event.type === "approval_request" ? [event.view?.kind ?? "generic"] : []))),
  );
  expect(parents.length).toBeGreaterThan(0);
  expect(bodies.length).toBe(7);
  expect(parents.filter((name) => !shown.has(name))).toEqual([]);
  expect([...shown].filter((name) => !parents.includes(name))).toEqual([]);
  expect(bodies.filter((name) => !kinds.has(name.slice(0, -"Body".length).toLowerCase()))).toEqual([]);
});

const stateFixtures = {
  RunStatus: {
    idle: ["run-status-idle"],
    running: ["run-status-running"],
    approval: ["run-status-approval"],
    unknown: ["run-status-outcome"],
  } satisfies Record<RunStatusValue, string[]>,
  RunEndMarker: {
    completed: ["run-end-marker-completed"],
    cancelled: ["run-end-marker-cancelled"],
    failed: ["run-end-marker-failed"],
    disconnected: ["run-end-marker-disconnected"],
    unknown: ["run-end-marker-unknown"],
  } satisfies Record<RunEndOutcome, string[]>,
  RunNavigator: ["run-navigator-open-failure"],
} as const;

const fixtureById = new Map(demos.map((demo) => [demo.id, demo]));
const reduced = (id: string) => {
  const demo = fixtureById.get(id);
  if (!demo) throw new Error(`missing gallery fixture: ${id}`);
  const store = createRunStore((flush) => flush());
  demo.events.forEach(store.dispatch);
  return { demo, state: store.getState(), store };
};

function statusOf(id: string): RunStatusValue {
  const { state, store } = reduced(id);
  if (state.agent !== "running") return state.endOutcome === "unknown" ? "unknown" : "idle";
  if (Object.values(state.toolApprovals).some((approvalId) => store.getItem(approvalId)?.type === "approval" && !store.getItem(approvalId)?.ended)) return "approval";
  return "running";
}

test("gallery fixtures cover every public run state", () => {
  for (const [status, ids] of Object.entries(stateFixtures.RunStatus)) expect(ids.some((id) => statusOf(id) === status), `${status} state is not rendered by its fixture`).toBe(true);
  for (const [outcome, ids] of Object.entries(stateFixtures.RunEndMarker)) {
    expect(ids.some((id) => reduced(id).state.endOutcome === outcome), `${outcome} outcome is not rendered by its fixture`).toBe(true);
  }
  for (const id of stateFixtures.RunNavigator) {
    const { demo } = reduced(id);
    expect(demo.runs).toBeDefined();
    expect(demo.events.some((event) => event.type === "sub_agent")).toBe(true);
    expect(demo.sourceFailure).toBe(true);
  }
});
