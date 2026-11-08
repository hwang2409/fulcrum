import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectZeta } from "@fulcrum/zeta";
import { startFakeZeta } from "../scripts/fake-zeta";

type Row = { content?: Array<{ type?: string; tool_call?: Record<string, unknown> }>; tool_result?: Record<string, unknown> | null };

// zeta docs/serve-protocol.md:1293-1303: the fake serves fidelity tool shapes only to a connection that negotiated them.
async function themesHistory(features: string[]) {
  const fake = await startFakeZeta({ origins: [], live: false });
  try {
    const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { controller_token: string };
    const client = await connectZeta({ url: `ws://127.0.0.1:${fake.port}/`, token: discovery.controller_token, features });
    try {
      await client.request("resume", { session_id: "s-themes" });
      const { messages } = await client.request("session_history", { session_id: "s-themes", offset: 0 }) as { messages: Row[] };
      const call = messages.flatMap((row) => row.content ?? []).find((block) => block.type === "tool_use")?.tool_call;
      const result = messages.find((row) => row.tool_result)?.tool_result;
      return { call, result };
    } finally {
      client.close();
    }
  } finally {
    await fake.close();
  }
}

test("with session_history_fidelity, fake history keeps tool arguments and the structured bash result", async () => {
  const { call, result } = await themesHistory(["session_history_fidelity"]);
  expect(call).toEqual({ id: "t-ls", name: "bash", arguments: { command: "ls packages/react/src" }, arguments_truncated: false });
  expect(result).toMatchObject({
    structured_content: { exit_code: 0, stdout: "themes.css\nthemes.ts\n", stderr: "", stdout_truncated: false, stderr_truncated: false, cwd_after: "/repo" },
    structured_content_truncated: false,
  });
});

test("without session_history_fidelity, fake history serves the legacy empty arguments and text-only result", async () => {
  const { call, result } = await themesHistory([]);
  expect(call).toEqual({ id: "t-ls", name: "bash", arguments: {} });
  expect(result).toMatchObject({ content: "stdout:\nthemes.css\nthemes.ts\n\nstderr:\n", structured_content: null });
  expect(result).not.toHaveProperty("structured_content_truncated");
});
