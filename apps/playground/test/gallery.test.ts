import { expect, test } from "bun:test";
import * as parts from "@fulcrum/react";
import { demos } from "../src/gallery/demos";

test("every exported part of @fulcrum/react has a gallery demo", () => {
  // Components are the capitalized value exports; RunProvider wraps every demo, so it needs none of its own.
  const components = Object.keys(parts).filter((name) => /^[A-Z]/.test(name) && name !== "RunProvider");
  const shown = new Set(demos.map((demo) => demo.part));
  expect(components.length).toBeGreaterThan(0);
  expect(components.filter((name) => !shown.has(name))).toEqual([]);
  expect([...shown].filter((name) => !components.includes(name))).toEqual([]);
});
