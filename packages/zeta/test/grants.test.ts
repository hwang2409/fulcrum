import { expect, test } from "bun:test";
import {
  SESSION_GRANTS_FEATURE,
  clearSessionGrants,
  createClient,
  getSessionGrants,
  isSessionGrantError,
  parseRevokeSessionGrants,
  parseSessionGrants,
  parseSessionGrantsChanged,
  revokeSessionGrant,
  type SessionGrantsChanged,
  type Transport,
} from "../src/index.js";

// zeta 66c084d8 docs/serve-protocol.md:615-660 and src/zeta/server/control.py:1030-1044.
const snapshot = {
  session_id: "s1",
  default: "ask",
  precedence: ["deny", "ask", "allow", "default"],
  rules: { deny: ["bash(rm *)"], ask: ["bash(git push*)"], allow: ["bash"] },
  session_grants: ["bash"],
} as const;
const mutableSnapshot = () => ({
  ...snapshot,
  precedence: [...snapshot.precedence],
  rules: {
    deny: [...snapshot.rules.deny],
    ask: [...snapshot.rules.ask],
    allow: [...snapshot.rules.allow],
  },
  session_grants: [...snapshot.session_grants],
});

// zeta 66c084d8 src/zeta/server/control.py:998-1044.
test("parses session grant snapshots and revoke results", () => {
  const current = mutableSnapshot();
  expect(parseSessionGrants(current)).toEqual(current);
  expect(parseRevokeSessionGrants({ removed: ["bash"], grants: { ...current, session_grants: [] } })).toEqual({
    removed: ["bash"], grants: { ...current, session_grants: [] },
  });
  expect(parseRevokeSessionGrants({ removed: [], grants: current })).toEqual({ removed: [], grants: current });
  expect(SESSION_GRANTS_FEATURE).toBe("session_grants");
});

test("drops malformed string rows and rejects malformed snapshots safely", () => {
  const current = mutableSnapshot();
  expect(parseSessionGrants({ ...current, rules: { ...current.rules, allow: ["bash", 4, null] } })).toEqual({
    ...current, rules: { ...current.rules, allow: ["bash"] },
  });
  for (const value of [
    null,
    {},
    { ...current, session_id: 4 },
    { ...current, default: "future" },
    { ...current, precedence: "ask" },
    { ...current, rules: { ...current.rules, deny: undefined } },
    { ...current, rules: { ...current.rules, ask: null } },
    { ...current, rules: { ...current.rules, allow: "bash" } },
    { ...current, session_grants: undefined },
  ]) expect(parseSessionGrants(value)).toBeNull();
});

test("rejects malformed revoke envelopes", () => {
  const current = mutableSnapshot();
  for (const value of [
    null,
    {},
    { grants: current },
    { removed: "bash", grants: current },
    { removed: [], grants: null },
    { removed: [], grants: { ...current, rules: null } },
  ]) expect(parseRevokeSessionGrants(value)).toBeNull();
  expect(parseRevokeSessionGrants({ removed: [4], grants: current })).toEqual({ removed: [], grants: current });
});

// zeta 66c084d8 docs/serve-protocol.md:651-655 and tests/test_server_session_grants.py:148-153,196-200,227-232.
test("parses all session grant change variants", () => {
  const current = mutableSnapshot();
  for (const change of ["grant", "revoke", "clear", "reset"] as const) {
    expect(parseSessionGrantsChanged({ change, changed: ["bash"], grants: current })).toEqual({
      change, changed: ["bash"], grants: current,
    });
  }
  expect(parseSessionGrantsChanged({ change: "future", changed: [], grants: current })).toBeNull();
  expect(parseSessionGrantsChanged({ change: "grant", changed: [null], grants: current })).toEqual({
    change: "grant", changed: [], grants: current,
  });
});

test("sends the exact protocol params for reading, revoking, and clearing", async () => {
  const options = { timeoutMs: 250 };
  const calls: Array<[string, Record<string, unknown>, unknown]> = [];
  const current = mutableSnapshot();
  const client = { request(method: string, params?: Record<string, unknown>, receivedOptions?: unknown) {
    calls.push([method, params ?? {}, receivedOptions]);
    return Promise.resolve(method === "session_grants" ? current : { removed: ["bash"], grants: { ...current, session_grants: [] } });
  } };
  await expect(getSessionGrants(client, options)).resolves.toEqual(current);
  await expect(revokeSessionGrant(client, "bash", options)).resolves.toHaveProperty("removed", ["bash"]);
  await expect(clearSessionGrants(client, options)).resolves.toHaveProperty("removed", ["bash"]);
  expect(calls).toEqual([
    ["session_grants", {}, options],
    ["revoke_session_grants", { grant: "bash" }, options],
    ["revoke_session_grants", { clear: true }, options],
  ]);
});

function fakeTransport() {
  let receive!: (text: string) => void;
  const transport: Transport = {
    send() {},
    onMessage(callback) { receive = callback; },
    close() {},
  };
  return { transport, receive: (message: unknown) => receive(JSON.stringify(message)) };
}

// zeta 66c084d8 docs/serve-protocol.md:651-655 and src/zeta/server/control.py:998-1044.
test("delivers valid session grant changes to host listeners until unsubscribe", () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport);
  const received: SessionGrantsChanged[] = [];
  const unsubscribe = client.onSessionGrantsChanged((event) => received.push(event));
  try {
    const current = mutableSnapshot();
    fake.receive({ jsonrpc: "2.0", method: "event", params: {
      event: "session_grants_changed", session_id: "s1", data: { change: "grant", changed: ["bash"], grants: current },
    } });
    fake.receive({ jsonrpc: "2.0", method: "event", params: {
      event: "session_grants_changed", session_id: "s1", data: { change: "future", changed: [], grants: current },
    } });
    expect(received).toEqual([{ change: "grant", changed: ["bash"], grants: current }]);
    unsubscribe();
    fake.receive({ jsonrpc: "2.0", method: "event", params: {
      event: "session_grants_changed", session_id: "s1", data: { change: "clear", changed: ["bash"], grants: { ...current, session_grants: [] } },
    } });
    expect(received).toHaveLength(1);
  } finally {
    client.close();
  }
});

// zeta 66c084d8 src/zeta/server/protocol.py:93-101 and control.py:1014-1019.
test("recognizes only session grant error data codes", () => {
  expect(isSessionGrantError({ code: -32602, data: { code: "invalid_session_grants_params" } })).toBe(true);
  expect(isSessionGrantError({ data: { code: "invalid_session_grants_revoke" } })).toBe(true);
  expect(isSessionGrantError({ data: { code: "session_grant_not_found", grant: "bash" } })).toBe(true);
  expect(isSessionGrantError({ data: { code: "other" } })).toBe(false);
  expect(isSessionGrantError({ data: "invalid_session_grants_params" })).toBe(false);
  expect(isSessionGrantError({ data: { code: 4 } })).toBe(false);
  expect(isSessionGrantError(null)).toBe(false);
});
