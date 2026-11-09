import { chromium } from "playwright";
import { spawn } from "node:child_process";
const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.PREPEND_PORT ?? 4177);
let preview: ReturnType<typeof spawn> | undefined;
process.on("exit", () => preview?.kill("SIGTERM"));
const targets = { correction: 120, thumb: 3, drift: 1, upward: 0.1, mutations: 7 };
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
  for (const [width, height] of [[390, 844], [1024, 768]] as const) {
    const page = await bounded(`${width}px page`, frameDeadlineMs, () => browser!.newPage({ viewport: { width, height } }));
    try {
      await bounded("page navigation", frameDeadlineMs, () => page.goto(`http://127.0.0.1:${port}/prepend.html?virtualDebug=1`));
      await bounded("initial virtual row", frameDeadlineMs, () => page.waitForSelector("[data-virtual-id]")); await bounded("initial render", frameDeadlineMs, () => page.waitForTimeout(1500));
      const upwardStart = await bounded("upward action probe", frameDeadlineMs, () => page.evaluate(() => (window as any).__fulcrumVirtual.getActions().at(-1)?.sequence ?? 0));
      const scroll = page.locator('[data-part="timeline-scroll"]'); const box = (await bounded("scroll bounds", frameDeadlineMs, () => scroll.boundingBox()))!;
      await bounded("pointer placement", frameDeadlineMs, () => page.mouse.move(box.x + box.width / 2, box.y + box.height / 2));
      for (let i = 0; i < 400; i++) { if (await bounded("scroll position", frameDeadlineMs, () => scroll.evaluate((el) => el.scrollTop)) < 250) break; await bounded("wheel scroll", frameDeadlineMs, () => page.mouse.wheel(0, -600)); await bounded("scroll settle", frameDeadlineMs, () => page.waitForTimeout(30)); }
      await bounded("scroll settle", frameDeadlineMs, () => page.waitForTimeout(1200));
      const probeBefore = await bounded("probe count", frameDeadlineMs, () => page.evaluate(() => (window as any).__probeCommits ?? 0));
      await bounded("commit probe", frameDeadlineMs, () => page.evaluate(() => { (window as any).__bumpCommit(); }));
      await bounded("commit probe timer", frameDeadlineMs, () => Bun.sleep(100));
      const probeCommits = (await bounded("probe count", frameDeadlineMs, () => page.evaluate(() => (window as any).__probeCommits ?? 0))) - probeBefore;
      const upward = await bounded("upward action probe", frameDeadlineMs, () => page.evaluate((start) => { const corrections = (window as any).__fulcrumVirtual.getActions().filter((a: any) => a.sequence > start && a.type === "correction"); return { sum: corrections.reduce((s: number, a: any) => s + a.detail.appliedCorrection, 0), abs: corrections.reduce((s: number, a: any) => s + Math.abs(a.detail.appliedCorrection), 0) }; }, upwardStart));
      const result = await bounded(`prepend samples for ${width}px`, frameDeadlineMs, () => page.evaluate(async ({ upward, probeCommits, deadlineMs }) => {
          const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for prepend samples")), deadlineMs));
          return Promise.race([ (async () => {
        const w = window as any, scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!, engine = w.__fulcrumVirtual;
        const pinnedBefore = engine.getSnapshot().pinned, beforeTop = scroll.scrollTop, upwardHeight = scroll.scrollHeight;
        if (pinnedBefore || beforeTop >= 250) return { setup: `pinnedBefore=${pinnedBefore}, scrollTop=${beforeTop}` };
        const box = scroll.getBoundingClientRect(); const anchor = [...scroll.querySelectorAll<HTMLElement>("[data-virtual-id]")].find((r) => r.getBoundingClientRect().top >= box.top)!; if (!anchor) throw new Error("prepend anchor row was not found"); const anchorId = anchor.dataset.virtualId!;
        const thumb = () => scroll.scrollTop / scroll.scrollHeight * scroll.clientHeight; const sample = () => ({ st: scroll.scrollTop, th: thumb(), at: document.querySelector<HTMLElement>(`[data-virtual-id="${anchorId}"]`)?.getBoundingClientRect().top ?? NaN });
        const before = sample(), seq = engine.getActions().at(-1)?.sequence ?? 0, commits = w.__commits, count = w.__prepend.outline().length; let mutations = 0; const mo = new MutationObserver(() => mutations++); mo.observe(scroll, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] }); w.__prepend.prepend(); const samples: any[] = []; const t0 = performance.now(); await new Promise<void>((resolve) => { const tick = () => { samples.push(sample()); performance.now() - t0 > 2000 ? resolve() : requestAnimationFrame(tick); }; requestAnimationFrame(tick); }); mo.disconnect();
        const actions = engine.getActions().filter((a: any) => a.sequence > seq), corrections = actions.filter((a: any) => a.type === "correction");
        const first = samples[0], last = samples.at(-1), drift = Math.max(...samples.map((s) => Number.isNaN(s.at) ? 0 : Math.abs(s.at - before.at)));
        return { setup: null, probeCommits, correction: last.st - first.st, thumb: Math.max(...samples.map((s) => Math.abs(s.th - first.th))), drift, missing: samples.filter((s) => Number.isNaN(s.at)).length, upward: upward.sum, height: Math.max(1, upwardHeight), commits: w.__commits - commits, measures: actions.filter((a: any) => a.type === "measure").length, mutations, inserted: w.__prepend.outline().length - count };
          })(), deadline ]);
        }, { upward, probeCommits, deadlineMs: frameDeadlineMs }));
      if (result.setup) { console.log(`width ${width}: setup failure: ${result.setup}`); continue; }
      const upwardPct = Math.abs(result.upward) / result.height;
      console.log(`width ${width} | correction ${result.correction.toFixed(1)} (target ±${targets.correction}, known: base) | thumb ${result.thumb.toFixed(1)} (target ≤${targets.thumb}, known: base) | drift ${result.drift.toFixed(2)} / missing ${result.missing} (target ≤${targets.drift}, known: base) | upward ${(upwardPct * 100).toFixed(1)}% (target ≤10%, known: base) | commits/probe-commit/measures/mutations ${result.commits}/${result.probeCommits}/${result.measures}/${result.mutations} (targets ${width === 390 ? 11 : 13}/${width === 390 ? 7 : 8}/${targets.mutations}, known: base)`);
    } finally { await bounded("page close", frameDeadlineMs, () => page.close()); }
  }
} catch (error) { console.log(`prepend-check setup failure: ${error instanceof Error ? error.message : String(error)}`); }
finally { if (browser) await bounded("browser close", frameDeadlineMs, () => browser!.close()); preview?.kill("SIGTERM"); }

process.exit(0);
