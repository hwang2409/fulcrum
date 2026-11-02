import { createClient } from "./client.js";
import { webSocketTransport } from "./transport.js";

/** Provisional websocket connection failure kinds. */
export type ZetaErrorKind =
  | "connect_failed"
  | "unauthorized"
  | "busy"
  | "version_mismatch"
  | "closed";

export class ZetaError extends Error {
  readonly name = "ZetaError";
  constructor(readonly kind: ZetaErrorKind) {
    super(kind);
  }
}

const errorKinds: Record<number, ZetaErrorKind> = {
  [-32008]: "unauthorized",
  [-32001]: "busy",
  [-32002]: "version_mismatch",
};

export interface ConnectZetaOptions {
  url: string;
  token: string;
  features?: string[];
}

export function connectZeta({ url, token, features }: ConnectZetaOptions) {
  return webSocketTransport(url)
    .catch(() => {
      throw new ZetaError("connect_failed");
    })
    .then((transport) => {
      const client = createClient(
        transport,
        undefined,
        (handshaken) => new ZetaError(handshaken ? "closed" : "unauthorized"),
      );
      return client.hello(features, { token }).catch((error: unknown) => {
        const kind =
          typeof error === "object" && error !== null && "code" in error
            ? errorKinds[(error as { code?: unknown }).code as number]
            : undefined;
        throw new ZetaError(kind ?? "unauthorized");
      }).then(() => client);
    });
}

export function parseConnectFragment(hash: string): { url: string; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const url = params.get("ws");
  const token = params.get("token");
  return url && token ? { url, token } : null;
}
