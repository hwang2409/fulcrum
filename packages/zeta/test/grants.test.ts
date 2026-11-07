import { expect, test } from "bun:test";
import {
  SESSION_GRANTS_FEATURE,
  getSessionGrants,
  isSessionGrantError,
  parseRevokeSessionGrants,
  parseSessionGrants,
  parseSessionGrantsChanged,
  revokeSessionGrants,
} from "../src/index.js";

// zeta 66c084d8 docs/serve-protocol.md:615-660 and src/zeta/server/control.py:1030-1040.
const snapshot = {
  session_id: "s1",
  default: "ask",
  precedence: ["deny", "ask", "allow", "default"],
  rules: { deny: ["bash(rm *)"], ask: ["bash(git push*)"], allow: ["bash"] },
  session_grants: ["bash"],
};

// zeta 66c084d8 src/zeta/server/control.py:998-1028.
test("parses session grant results and changed events", () => {
  expect(parseSessionGrants(snapshot)).toEqual(snapshot);
  expect(parseRevokeSessionGrants({ removed: ["bash"], grants: { ...snapshot, session_grants: [] } })).toEqual({
    removed: ["bash"], grants: { ...snapshot, session_grants: [] },
  });
  expect(parseSessionGrantsChanged({ change: "revoke", changed: ["bash"], grants: { ...snapshot, session_grants: [] } })).toEqual({
    change: "revoke", changed: ["bash"], grants: { ...snapshot, session_grants: [] },
  });
  expect(SESSION_GRANTS_FEATURE).toBe("session_grants");
});

test("drops malformed grant rows and rejects malformed frames safely", () => {
  expect(parseSessionGrants({ ...snapshot, rules: { ...snapshot.rules, allow: ["bash", 4, null] } })).toEqual({
    ...snapshot, rules: { ...snapshot.rules, allow: ["bash"] },
  });
  for (const value of [null, {}, { ...snapshot, session_id: 4 }, { ...snapshot, rules: null }, { ...snapshot, precedence: "ask" }]) {
    expect(parseSessionGrants(value)).toBeNull();
  }
  expect(parseRevokeSessionGrants({ removed: [4], grants: snapshot })).toEqual({ removed: [], grants: snapshot });
  expect(parseSessionGrantsChanged({ change: "future", changed: [], grants: snapshot })).toBeNull();
  expect(parseSessionGrantsChanged({ change: "grant", changed: [null], grants: snapshot })).toEqual({ change: "grant", changed: [], grants: snapshot });
});

test("forwards grant methods, params, and request options", async () => {
  const options = { timeoutMs: 250 };
  const calls: Array<[string, Record<string, unknown>, unknown]> = [];
  const client = { request(method: string, params?: Record<string, unknown>, receivedOptions?: unknown) {
    calls.push([method, params ?? {}, receivedOptions]);
    return Promise.resolve(method === "session_grants" ? snapshot : { removed: ["bash"], grants: { ...snapshot, session_grants: [] } });
  } };
  await expect(getSessionGrants(client, "s1", options)).resolves.toEqual(snapshot);
  await expect(revokeSessionGrants(client, "s1", { grant: "bash" }, options)).resolves.toHaveProperty("removed", ["bash"]);
  await expect(revokeSessionGrants(client, "s1", { clear: true }, options)).resolves.toHaveProperty("removed", ["bash"]);
  expect(calls).toEqual([
    ["session_grants", { session_id: "s1" }, options],
    ["revoke_session_grants", { session_id: "s1", grant: "bash" }, options],
    ["revoke_session_grants", { session_id: "s1", clear: true }, options],
  ]);
});

// zeta 66c084d8 src/zeta/server/protocol.py:93-101 and control.py:1014-1019.
test("recognizes only session grant error data codes", () => {
  expect(isSessionGrantError({ code: -32602, data: { code: "invalid_session_grants_params" } })).toBe(true);
  expect(isSessionGrantError({ data: { code: "invalid_session_grants_revoke" } })).toBe(true);
  expect(isSessionGrantError({ data: { code: "session_grant_not_found", grant: "bash" } })).toBe(true);
  expect(isSessionGrantError({ data: { code: "other" } })).toBe(false);
  expect(isSessionGrantError(null)).toBe(false);
});
