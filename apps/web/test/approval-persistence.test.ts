import { expect, test } from "bun:test";
import { connectZeta } from "@fulcrum/zeta";
import { createDelivery } from "../src/delivery";
import { startFakeZeta } from "../scripts/fake-zeta";

test("an approval persistence refusal stays idle, keeps the draft, explains recovery, and sends once", async () => {
  const fake = await startFakeZeta({ origins: [], live: false });
  try {
    const discovery = JSON.parse(await Bun.file(`${fake.home}/run/serve.ws.json`).text()) as { controller_token: string };
    const client = await connectZeta({ url: `ws://127.0.0.1:${fake.port}/`, token: discovery.controller_token });
    try {
      fake.setMode("approval-persistence-failed");
      const status = await client.request("status") as { state: string };
      const delivery = createDelivery(() => "approval-failure-delivery");
      let draft = "keep this draft";
      const failure = await delivery.submit(client, draft, false).then(
        () => { draft = ""; return null; },
        (error: unknown) => error,
      );

      expect(status.state).toBe("idle");
      expect(draft).toBe("keep this draft");
      expect(failure).toMatchObject({
        message: "zeta cannot save approvals right now. restart zeta serve to continue.",
        cause: { name: "ApprovalPersistenceError", kind: "approval_persistence_failed", code: -32000, data: { code: "approval_persistence_failed" } },
      });
      expect(fake.requests.filter(({ method }) => method === "send")).toHaveLength(1);
    } finally {
      client.close();
    }
  } finally {
    await fake.close();
  }
});
