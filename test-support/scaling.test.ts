import { expect, test } from "bun:test";
import { expectSubquadratic } from "./scaling.js";

let sink = 0;

test("accepts linear work", () => {
  expectSubquadratic([100_000, 3_200_000], (size) => () => { for (let index = 0; index < size; index++) sink += index & 7; });
});

test("rejects quadratic work", () => {
  expect(() => expectSubquadratic([200, 6_400], (size) => () => {
    for (let outer = 0; outer < size; outer++) for (let inner = 0; inner < size; inner++) sink += inner & outer & 7;
  })).toThrow("time grew");
});

test("refuses a size span too narrow to separate linear from quadratic", () => {
  expect(() => expectSubquadratic([10_000, 80_000], () => () => {})).toThrow("at least 32x");
  expect(sink).toBeGreaterThan(0);
});
