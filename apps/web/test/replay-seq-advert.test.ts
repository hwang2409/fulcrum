import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectZeta } from "@fulcrum/zeta";
import { FEATURES } from "../src/connection";
import { LONG, startFakeZeta } from "../scripts/fake-zeta";
import { openSession } from "../src/session";

// live zeta 0f29a2b3 offers session_replay_seq to any client that asks; the app must still open sessions.
test("the app's hello against a server that offers session_replay_seq still opens a session and loads newest history", async () => {
  const fake = await startFakeZeta({ origins: [], live: false, replaySeqOffered: true });
  try {
    const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { controller_token: string };
    const client = await connectZeta({ url: `ws://127.0.0.1:${fake.port}/`, token: discovery.controller_token, role: "controller", features: FEATURES });
    let release: (() => void) | undefined;
    try {
      const opened = await openSession(client, LONG);
      release = () => opened.lease.release();
      await opened.complete;
      expect(opened.lease.store.getState().outline.length).toBeGreaterThan(0);
    } finally {
      release?.();
      client.close();
    }
  } finally {
    await fake.close();
  }
});
