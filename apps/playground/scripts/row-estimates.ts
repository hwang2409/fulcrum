import { chromium } from "playwright";
import { spawn } from "node:child_process";
const root = new URL("..", import.meta.url).pathname, port = Number(process.env.PREPEND_PORT ?? 4177);
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
process.on("exit", () => preview.kill("SIGTERM")); const browser = await chromium.launch();
try {
  for (let i = 0; i < 100; i++) { if (await fetch(`http://127.0.0.1:${port}/prepend.html`).then((r) => r.ok, () => false)) break; if (i === 99) throw new Error("vite preview did not start"); await Bun.sleep(100); }
  for (const [width, height] of [[390, 844], [1024, 768]] as const) {
    const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${port}/prepend.html?virtualDebug=1`); await page.waitForSelector("[data-virtual-id]");
    const table = await page.evaluate(async () => { const w = window as any, scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!, engine = w.__fulcrumVirtual; for (let y = 0; y <= scroll.scrollHeight; y += scroll.clientHeight / 2) { scroll.scrollTop = y; await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); } await new Promise<void>((r) => requestAnimationFrame(() => r())); const kinds = new Map(w.__prepend.outline().map((o: any) => [o.id, o.kind])), values: Record<string, number[]> = {}; for (const [id, size] of engine.snapshotCache().sizes) (values[kinds.get(id) ?? "unknown"] ??= []).push(size); return Object.entries(values).map(([kind, xs]) => ({ kind, n: xs.length, min: Math.min(...xs), median: xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)], mean: xs.reduce((a, b) => a + b, 0) / xs.length, max: Math.max(...xs) })); });
    console.log(`width ${width}`); console.table(table); await page.close();
  }
} catch (error) { console.log(`row-estimates setup failure: ${error instanceof Error ? error.message : String(error)}`); } finally { await browser.close(); }
process.exit(0);
