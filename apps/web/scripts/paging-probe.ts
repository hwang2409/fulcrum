// Measurement only (scratch, never merged): seconds from the first load of the 1,000-row LONG run to "history paging
// finished" (the "loading session history" line detached), RUNS times per engine, each in a fresh context.
import { spawn } from "node:child_process";
import { chromium, firefox } from "playwright";
import { LONG, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.WEB_GATE_PORT ?? 4183);
const origin = `http://127.0.0.1:${port}`;
const fake = await startFakeZeta({ origins: [origin] });
fake.setLive(false);
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home }, stdio: "ignore" });
const runs = Number(process.env.RUNS ?? 5);
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    if (attempt > 600) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  for (const [name, launch] of [["firefox", () => firefox.launch()], ["chromium", () => chromium.launch()]] as const) {
    const browser = await launch();
    const times: number[] = [];
    try {
      for (let run = 0; run <= runs; run++) { // run 0 warms the engine and vite; not counted
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        try {
          const page = await context.newPage();
          const opened = Date.now();
          await page.goto(`${origin}/?theme=tokyo-night#session=${LONG}`);
          await page.locator('[data-run-ready="true"]').waitFor({ timeout: 120_000 });
          await page.getByText(/loading session history/).waitFor({ state: "detached", timeout: 120_000 });
          const seconds = (Date.now() - opened) / 1000;
          await page.locator('[data-virtual-id="message:l999"]').waitFor({ state: "attached", timeout: 30_000 });
          console.log(`PAGING ${name} run ${run}${run === 0 ? " (warm-up)" : ""} ${seconds.toFixed(2)} s`);
          if (run > 0) times.push(seconds);
        } catch (error) {
          console.log(`PAGING ${name} run ${run} FAIL ${error instanceof Error ? error.message.split("\n")[0] : error}`);
        } finally {
          await context.close();
        }
      }
    } finally { await browser.close(); }
    console.log(`PAGING_MEDIAN ${name} ${times.length ? median(times).toFixed(2) : "none"} s over ${times.length} [${times.map((t) => t.toFixed(2)).join(", ")}]`);
  }
} finally {
  vite.kill("SIGTERM");
  await fake.close();
}
process.exit(0);
