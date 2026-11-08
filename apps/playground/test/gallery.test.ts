import { expect, test } from "bun:test";
import * as parts from "@fulcrum/react";
import { createRunStore, type RunEndOutcome } from "@fulcrum/core";
import type { RunStatusValue } from "@fulcrum/react";
import { codeDemos } from "../src/gallery/code-demos";
import { composerDemos } from "../src/gallery/composer-demos";
import { demos } from "../src/gallery/demos";
import { sourceFor } from "../src/gallery/source";

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

const expectedStates = {
  RunStatus: { idle: true, running: true, approval: true, unknown: true } satisfies Record<RunStatusValue, true>,
  RunEndMarker: { completed: true, cancelled: true, failed: true, disconnected: true, unknown: true } satisfies Record<RunEndOutcome, true>,
} as const;

const demosFor = (part: string) => demos.filter((demo) => demo.part === part);
const reduced = (demo: (typeof demos)[number]) => {
  const store = createRunStore((flush) => flush());
  demo.events.forEach(store.dispatch);
  return { demo, state: store.getState(), store };
};

function statusOf(demo: (typeof demos)[number]): RunStatusValue {
  const { state, store } = reduced(demo);
  if (state.agent !== "running") return state.endOutcome === "unknown" ? "unknown" : "idle";
  if (Object.values(state.toolApprovals).some((approvalId) => store.getItem(approvalId)?.type === "approval" && !store.getItem(approvalId)?.ended)) return "approval";
  return "running";
}

test("gallery fixtures cover every public run state", () => {
  const observed = {
    RunStatus: new Set(demosFor("RunStatus").map(statusOf)),
    RunEndMarker: new Set(demosFor("RunEndMarker").map((demo) => reduced(demo).state.endOutcome).filter(Boolean)),
  };
  for (const [part, expected] of Object.entries(expectedStates)) {
    const missing = Object.keys(expected).filter((state) => !observed[part as keyof typeof observed].has(state));
    expect(missing, `${part} is missing gallery states: ${missing.join(", ")}`).toEqual([]);
  }
});

test("gallery navigator failure fixture opens through its configured source error", () => {
  const demo = demosFor("RunNavigator").find((candidate) => candidate.sourceFailure);
  expect(demo).toBeDefined();
  const failure = demo!.sourceFailure!;
  expect(demo!.events.some((event) => event.type === "sub_agent" && event.childRunId === failure.runId)).toBe(true);
  const source = sourceFor({}, failure);
  expect(() => source.open(failure.runId)).toThrow(failure.error);
});
