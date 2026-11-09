import { chromium } from "playwright";
import { spawn } from "node:child_process";
const root = new URL("..", import.meta.url).pathname, port = Number(process.env.PREPEND_PORT ?? 4177);
let preview: ReturnType<typeof spawn> | undefined;
process.on("exit", () => preview?.kill("SIGTERM"));
const frameDeadlineMs = 10_000;
// one deadline owner: every browser, page, and preview operation goes through this helper.
async function bounded<T>(label: string, ms: number, operation: () => Promise<T>): Promise<T> {
  return Promise.race([operation(), Bun.sleep(ms).then(() => { throw new Error(`timed out ${label}`); })]);
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
  browser = await bounded("Chromium launch", frameDeadlineMs, () => chromium.launch());
  for (let i = 0; i < 100; i++) { if (await bounded("preview readiness fetch", frameDeadlineMs, () => fetch(`http://127.0.0.1:${port}/prepend.html`).then((r) => r.ok, () => false))) break; if (i === 99) throw new Error("vite preview did not start"); await bounded("preview readiness delay", frameDeadlineMs, () => Bun.sleep(100)); }
  const byWidth = new Map<number, { kind: string; mean: number }[]>();
  for (const [width, height] of [[390, 844], [1024, 768]] as const) {
    const page = await bounded(`${width}px page`, frameDeadlineMs, () => browser!.newPage({ viewport: { width, height } }));
    try {
      await bounded("page navigation", frameDeadlineMs, () => page.goto(`http://127.0.0.1:${port}/prepend.html?virtualDebug=1`)); await bounded("initial virtual row", frameDeadlineMs, () => page.waitForSelector("[data-virtual-id]"));
      const table = await bounded(`row-estimate frames for ${width}px`, frameDeadlineMs, () => page.evaluate(async (deadlineMs) => {
          const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for row-estimate frames")), deadlineMs));
          return Promise.race([(async () => {
            const w = window as any, scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!, engine = w.__fulcrumVirtual;
            for (let y = 0; y <= scroll.scrollHeight; y += scroll.clientHeight / 2) { scroll.scrollTop = y; await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); }
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            const kinds = new Map(w.__prepend.outline().map((o: any) => [o.id, o.kind])), values: Record<string, number[]> = {};
            for (const [id, size] of engine.snapshotCache().sizes) (values[kinds.get(id) ?? "unknown"] ??= []).push(size);
            return Object.entries(values).map(([kind, xs]) => ({ kind, n: xs.length, min: Math.min(...xs), median: xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)], mean: xs.reduce((a, b) => a + b, 0) / xs.length, max: Math.max(...xs) }));
          })(), deadline]);
        }, frameDeadlineMs));
      byWidth.set(width, table);
      console.log(`width ${width}`); console.table(table);
    } finally { await bounded("page close", frameDeadlineMs, () => page.close()); }
  }
  const kinds = [...new Set([...byWidth.values()].flatMap((rows) => rows.map((row) => row.kind)))].sort();
  console.log("proposed seeds (round(mean of the 390 mean and the 1024 mean) per kind):");
  for (const kind of kinds) {
    const mean390 = byWidth.get(390)!.find((row) => row.kind === kind)?.mean;
    const mean1024 = byWidth.get(1024)!.find((row) => row.kind === kind)?.mean;
    if (mean390 !== undefined && mean1024 !== undefined) console.log(`${kind}: ${Math.round((mean390 + mean1024) / 2)}`);
  }
} catch (error) { console.log(`row-estimates setup failure: ${error instanceof Error ? error.message : String(error)}`); }
finally { if (browser) await bounded("browser close", frameDeadlineMs, () => browser!.close()); preview?.kill("SIGTERM"); }
process.exit(0);
