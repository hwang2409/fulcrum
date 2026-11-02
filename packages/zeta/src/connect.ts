import { createClient } from "./client.js";
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

export interface ConnectZetaOptions {
  url: string;
  token: string;
  features?: string[];
}

export function connectZeta({ url, token, features }: ConnectZetaOptions) {
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
    const parsed = new URL(text);
    const token = parsed.searchParams.get("token");
    if (!isLoopbackWebSocketUrl(parsed) || parsed.pathname !== "/" || !token)
      return null;
    parsed.searchParams.delete("token");
    return { url: parsed.toString(), token };
  } catch {
    return null;
  }
}

export function parseConnectFragment(hash: string): { url: string; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const url = params.get("ws");
  const token = params.get("token");
  if (!url || !token) return null;
  try {
    return isLoopbackWebSocketUrl(new URL(url)) ? { url, token } : null;
  } catch {
    return null;
  }
}
