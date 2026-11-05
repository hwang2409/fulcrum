import { createClient } from "./client.js";
import type { HostCommandSupplier } from "./host-commands.js";
import { webSocketTransport } from "./transport.js";

export type ZetaErrorKind =
  | "connect_failed"
  | "busy"
  | "version_mismatch"
  | "closed";

const connectFailedMessage =
  "zeta connection failed; check the websocket url and token, the --ws-origin allowlist, and that zeta serve is running";

export class ZetaError extends Error {
  readonly name = "ZetaError";
  constructor(readonly kind: ZetaErrorKind, readonly code?: number) {
    super(kind === "connect_failed" ? connectFailedMessage : kind === "closed" ? `zeta websocket closed (${code})` : kind);
  }
}

const errorKinds: Record<number, ZetaErrorKind> = {
  [-32001]: "busy",
  [-32002]: "version_mismatch",
};

function isLoopbackWebSocketUrl(url: URL): boolean {
  return ["ws:", "wss:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function parseWebSocketUrl(text: string): { url: string; token: string | null } | null {
  try {
    const parsed = new URL(text);
    if (!isLoopbackWebSocketUrl(parsed)) return null;
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");
    return { url: parsed.toString(), token };
  } catch {
    return null;
  }
}

export interface ConnectZetaOptions {
  url: string;
  token: string;
  features?: string[];
  /** Enables host commands and supplies a fresh binding for every new session or resume. */
  hostCommands?: HostCommandSupplier | null;
}

export function connectZeta({ url, token, features, hostCommands }: ConnectZetaOptions) {
  let websocketUrl: string;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("token", token);
    websocketUrl = parsed.toString();
  } catch {
    return Promise.reject(new ZetaError("connect_failed"));
  }
  return webSocketTransport(websocketUrl)
    .catch(() => {
      throw new ZetaError("connect_failed");
    })
    .then((transport) => {
      const client = createClient(
        transport,
        undefined,
        (handshaken, code) =>
          new ZetaError(handshaken ? "closed" : "connect_failed", code),
        { hostCommands },
      );
      return client.hello(features).catch((error: unknown) => {
        const kind =
          typeof error === "object" && error !== null && "code" in error
            ? errorKinds[(error as { code?: unknown }).code as number]
            : undefined;
        throw new ZetaError(kind ?? "connect_failed");
      }).then(() => client);
    });
}

export function parseZetaUrl(text: string): { url: string; token: string } | null {
  try {
    if (new URL(text).pathname !== "/") return null;
  } catch {
    return null;
  }
  const parsed = parseWebSocketUrl(text);
  return parsed && parsed.token ? { url: parsed.url, token: parsed.token } : null;
}

export function parseConnectFragment(hash: string): { url: string; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const url = params.get("ws");
  const fragmentToken = params.get("token");
  if (!url) return null;
  const parsed = parseWebSocketUrl(url);
  if (!parsed) return null;
  if (parsed.token && fragmentToken && parsed.token !== fragmentToken) return null;
  const token = fragmentToken || parsed.token;
  return token ? { url: parsed.url, token } : null;
}

/** What a dev-server discovery handoff returns. `origins` is the server's `--ws-origin` allowlist. */
export type ZetaDiscovery = { url: string; token: string; origins: string[] };
/** The same-origin path `zetaDiscoveryPlugin` from `@fulcrum/zeta/discovery` serves. */
export const zetaDiscoveryPath = "/__fulcrum/zeta";

/** Asks the page's own dev server for the running `zeta serve --ws`; `null` when no server runs (204, or 404 without the handler). */
export async function discoverZeta(path = zetaDiscoveryPath): Promise<ZetaDiscovery | null> {
  const response = await fetch(path, { cache: "no-store" });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error(`zeta discovery failed (${response.status})`);
  const value = (await response.json()) as Partial<ZetaDiscovery>;
  if (typeof value.url !== "string" || typeof value.token !== "string") throw new Error("zeta discovery returned an invalid body");
  return { url: value.url, token: value.token, origins: Array.isArray(value.origins) ? value.origins.filter((origin) => typeof origin === "string") : [] };
}
