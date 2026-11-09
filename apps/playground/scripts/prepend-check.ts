import { chromium } from "playwright";
import { spawn } from "node:child_process";
const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.PREPEND_PORT ?? 4177);
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
const stop = () => preview.kill("SIGTERM"); process.on("exit", stop);
const targets = { correction: 120, thumb: 3, drift: 1, upward: 0.1, commits: 11, measures: 7, mutations: 7 };
const browser = await chromium.launch();
try {
  for (let i = 0; i < 100; i++) { if (await fetch(`http://127.0.0.1:${port}/prepend.html`).then((r) => r.ok, () => false)) break; if (i === 99) throw new Error("vite preview did not start"); await Bun.sleep(100); }
  for (const [width, height] of [[390, 844], [1024, 768]] as const) {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.goto(`http://127.0.0.1:${port}/prepend.html?virtualDebug=1`);
      await page.waitForSelector("[data-virtual-id]"); await page.waitForTimeout(1500);
      const scroll = page.locator('[data-part="timeline-scroll"]'); const box = (await scroll.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 400; i++) { if (await scroll.evaluate((el) => el.scrollTop) < 250) break; await page.mouse.wheel(0, -600); await page.waitForTimeout(30); }
      await page.waitForTimeout(1200);
      const result = await page.evaluate(async () => {
        const w = window as any, scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!, engine = w.__fulcrumVirtual;
        const pinnedBefore = engine.getSnapshot().pinned, beforeTop = scroll.scrollTop;
        if (pinnedBefore || beforeTop >= 250) return { setup: `pinnedBefore=${pinnedBefore}, scrollTop=${beforeTop}` };
        const box = scroll.getBoundingClientRect(); const anchor = [...scroll.querySelectorAll<HTMLElement>("[data-virtual-id]")].find((r) => r.getBoundingClientRect().top >= box.top)!; const anchorId = anchor.dataset.virtualId!;
        const thumb = () => scroll.scrollTop / scroll.scrollHeight * scroll.clientHeight; const sample = () => ({ st: scroll.scrollTop, th: thumb(), at: document.querySelector<HTMLElement>(`[data-virtual-id="${anchorId}"]`)?.getBoundingClientRect().top ?? NaN });
        const before = sample(), seq = engine.getActions().at(-1)?.sequence ?? 0, commits = w.__commits, count = w.__prepend.outline().length; let mutations = 0; const mo = new MutationObserver(() => mutations++); mo.observe(scroll, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] }); w.__prepend.prepend(); const samples: any[] = []; const t0 = performance.now(); await new Promise<void>((resolve) => { const tick = () => { samples.push(sample()); performance.now() - t0 > 2000 ? resolve() : requestAnimationFrame(tick); }; requestAnimationFrame(tick); }); mo.disconnect();
        const actions = engine.getActions().filter((a: any) => a.sequence > seq), corrections = actions.filter((a: any) => a.type === "correction");
        let upward = 0; for (const a of engine.getActions().filter((a: any) => a.sequence > seq && a.type === "correction")) upward += Math.abs(a.detail.appliedCorrection);
        const first = samples[0], last = samples.at(-1), drift = Math.max(...samples.map((s) => Number.isNaN(s.at) ? 0 : Math.abs(s.at - before.at)));
        return { setup: null, correction: last.st - first.st, thumb: Math.max(...samples.map((s) => Math.abs(s.th - first.th))), drift, missing: samples.filter((s) => Number.isNaN(s.at)).length, upward, height: Math.max(1, Math.abs(last.st - first.st) + upward), commits: w.__commits - commits, measures: actions.filter((a: any) => a.type === "measure").length, mutations, inserted: w.__prepend.outline().length - count };
      });
      if (result.setup) { console.log(`width ${width}: setup failure: ${result.setup}`); continue; }
      const upwardPct = result.upward / result.height;
      console.log(`width ${width} | correction ${result.correction.toFixed(1)} (target ±${targets.correction}, known: base) | thumb ${result.thumb.toFixed(1)} (target ≤${targets.thumb}, known: base) | drift ${result.drift.toFixed(2)} / missing ${result.missing} (target ≤${targets.drift}, known: base) | upward ${(upwardPct * 100).toFixed(1)}% (target ≤10%, known: base) | commits/measures/mutations ${result.commits}/${result.measures}/${result.mutations} (targets ${targets.commits}/${targets.measures}/${targets.mutations}, known: base)`);
    } finally { await page.close(); }
  }
} catch (error) { console.log(`prepend-check setup failure: ${error instanceof Error ? error.message : String(error)}`); }
await browser.close();
process.exit(0);
