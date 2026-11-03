import { expect, test } from "bun:test";
import * as parts from "@fulcrum/react";
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
