import type { RequestOptions } from "./client.js";

export const SESSION_GRANTS_FEATURE = "session_grants" as const;

export type PermissionRuleSet = {
  deny: string[];
  ask: string[];
  allow: string[];
};

export type SessionGrantDefault = "allow" | "deny" | "ask";

export interface SessionGrantsSnapshot {
  session_id: string;
  default: SessionGrantDefault;
  precedence: string[];
  rules: PermissionRuleSet;
  session_grants: string[];
}

export interface RevokeSessionGrantsResult {
  removed: string[];
  grants: SessionGrantsSnapshot;
}

export type SessionGrantChange = "grant" | "revoke" | "clear" | "reset";

export interface SessionGrantsChanged {
  change: SessionGrantChange;
  changed: string[];
  grants: SessionGrantsSnapshot;
}

export type SessionGrantErrorCode =
  | "invalid_session_grants_params"
  | "invalid_session_grants_revoke"
  | "session_grant_not_found";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : null;

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;

const snapshot = (value: unknown): SessionGrantsSnapshot | null => {
  const row = object(value);
  const rules = object(row?.rules);
  const deny = strings(rules?.deny);
  const ask = strings(rules?.ask);
  const allow = strings(rules?.allow);
  const precedence = strings(row?.precedence);
  const sessionGrants = strings(row?.session_grants);
  if (!row || !rules || typeof row.session_id !== "string" ||
      row.default !== "allow" && row.default !== "deny" && row.default !== "ask" ||
      !precedence || !deny || !ask || !allow || !sessionGrants) return null;
  return {
    session_id: row.session_id,
    default: row.default,
    precedence,
    rules: { deny, ask, allow },
    session_grants: sessionGrants,
  };
}

/** Parses the `session_grants` result from zeta without throwing. */
export function parseSessionGrants(value: unknown): SessionGrantsSnapshot | null {
  return snapshot(value);
}

/** Parses the `revoke_session_grants` result from zeta without throwing. */
export function parseRevokeSessionGrants(value: unknown): RevokeSessionGrantsResult | null {
  const row = object(value);
  const removed = strings(row?.removed);
  const grants = snapshot(row?.grants);
  return row && removed && grants ? { removed, grants } : null;
}

/** Parses `session_grants_changed` event data from zeta without throwing. */
export function parseSessionGrantsChanged(value: unknown): SessionGrantsChanged | null {
  const row = object(value);
  const changed = strings(row?.changed);
  const grants = snapshot(row?.grants);
  if (!row || !changed || !grants ||
      row.change !== "grant" && row.change !== "revoke" && row.change !== "clear" && row.change !== "reset") return null;
  return { change: row.change, changed, grants };
}

/** Recognizes the session-grant protocol error data codes. */
export function isSessionGrantError(value: unknown): value is { data: { code: SessionGrantErrorCode } } {
  const data = object(object(value)?.data);
  return data?.code === "invalid_session_grants_params" ||
    data?.code === "invalid_session_grants_revoke" || data?.code === "session_grant_not_found";
}

export interface GrantsClient {
  request(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
}

export function getSessionGrants(client: GrantsClient, options?: RequestOptions): Promise<SessionGrantsSnapshot | null> {
  return client.request("session_grants", {}, options).then(parseSessionGrants);
}

export function revokeSessionGrant(client: GrantsClient, grant: string, options?: RequestOptions): Promise<RevokeSessionGrantsResult | null> {
  return client.request("revoke_session_grants", { grant }, options).then(parseRevokeSessionGrants);
}

export function clearSessionGrants(client: GrantsClient, options?: RequestOptions): Promise<RevokeSessionGrantsResult | null> {
  return client.request("revoke_session_grants", { clear: true }, options).then(parseRevokeSessionGrants);
}
