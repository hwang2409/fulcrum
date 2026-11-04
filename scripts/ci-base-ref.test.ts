import { describe, expect, test } from "bun:test";
import { selectBaseRef } from "./ci-base-ref";

describe("selectBaseRef", () => {
  test("falls back for GitHub's all-zero first-push sha", () => {
    expect(selectBaseRef("0000000000000000000000000000000000000000", true)).toBe("HEAD^");
  });

  test("uses origin/main when the branch has no parent", () => {
    expect(selectBaseRef(undefined, false)).toBe("origin/main");
  });

  test("keeps a real event sha", () => {
    expect(selectBaseRef("abc123", true)).toBe("abc123");
  });
});
