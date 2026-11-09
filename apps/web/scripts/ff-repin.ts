// Measurement only: the firefox End/PageDown animated re-pin rows of apps/web/scripts/gate.ts (PR #108), copied verbatim,
// run RUNS times each. Same fixture (fake-zeta LONG 1,000 rows), same assertions. Scratch runner, never merged.
import { spawn } from "node:child_process";
import { firefox, type Locator, type Page } from "playwright";
import { LONG, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.WEB_GATE_PORT ?? 4181);
const origin = `http://127.0.0.1:${port}`;
const fake = await startFakeZeta({ origins: [origin] });
fake.setLive(false);
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home }, stdio: "ignore" });
const runs = Number(process.env.RUNS ?? 10);
const tally: Record<string, { pass: number; fail: number }> = {};
const waitAtBottom = (page: Page, failure: string) => page.waitForFunction((selector) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return false;
  const range = element.scrollHeight - element.clientHeight;
  return range > 0 && Math.abs(element.scrollTop - range) <= 1;
}, '[data-part="timeline-scroll"]', { timeout: 15_000 }).catch(() => { throw new Error(failure); });

async function withRowPage(page: Page, engine: string, row: (rowPage: Page) => Promise<void>, prepare?: (rowPage: Page) => Promise<void>) {
  const browser = page.context().browser();
  if (!browser) throw new Error(`${engine}: gate row browser is unavailable`);
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.goto("about:blank");
  const context = await browser.newContext({ viewport });
  try {
    const rowPage = await context.newPage();
    await prepare?.(rowPage);
    await row(rowPage);
  } finally {
    await context.close();
  }
}

// A wait whose timeout names what did not happen.
const waitNamed = (locator: Locator, failure: string, timeout: number, state: "attached" | "detached" | "visible" = "visible") =>
  locator.waitFor({ state, timeout }).catch(() => { throw new Error(`${failure} within ${timeout / 1000} s`); });

// Review 4 B1: browsers animate key scrolls, so one reader gesture reaches the end over several scroll callbacks. A
// reader who scrolls down to the end with real input follows again. The row first proves the gesture took more than one
// callback, so it cannot pass on an engine that did not animate it. Real input only, named waits. Headless wheel input
// does not animate (one callback in Chromium and WebKit), so the wheel case lives in the hook rows. "PageDown (body
// focus)" clicks a row and then moves focus to the page body: the browser scrolls the scroller of the last click.
// WebKit's End from a focused row does not end at the end of a virtual list (probe: it lands on the DOM end of that
// moment, then rows measure and the end moves; focus also leaves the row), so WebKit presses PageDown until the end
// instead. WebKit's later PageDowns from a focused row move less than a page (probe: 638 px, then 241 px, on 110b875
// and on this branch alike), so the row repeats the key, up to five times, and counts the callbacks of the last press.
type AnimatedGesture = "PageDown" | "End" | "PageDown repeated" | "PageDown (body focus)";

// A freshly launched engine loads the app cold (module graph, fonts, the first history pages). Open the long run once,
// in a row context like the rows use, before the first row. These rows are new: their load waits are 30 s, since Firefox
// loads the 1,000-row run slowly on a busy machine.
async function warmEngine(page: Page, engine: string) {
  const history = fake.historyOf(LONG);
  try {
    await withRowPage(page, engine, async (rowPage) => {
      await rowPage.goto(`${origin}/?theme=tokyo-night#session=${LONG}`);
      await waitNamed(rowPage.locator('[data-run-ready="true"]'), `${engine}: warm-up: the long run was not ready`, 30_000);
      await waitNamed(rowPage.getByText(/loading session history/), `${engine}: warm-up: history paging did not finish`, 30_000, "detached");
    });
  } finally {
    fake.restoreHistory(LONG, history);
  }
}

async function checkAnimatedReaderScrollRepins(page: Page, engine: string, gesture: AnimatedGesture) {
  const history = fake.historyOf(LONG);
  try {
    await withRowPage(page, engine, async (rowPage) => {
      const row = `${engine} animated ${gesture} re-pin`;
      await rowPage.goto(`${origin}/?theme=tokyo-night&virtualDebug=1#session=${LONG}`);
      await waitNamed(rowPage.locator('[data-run-ready="true"]'), `${row}: the long run was not ready`, 30_000);
      await waitNamed(rowPage.getByText(/loading session history/), `${row}: history paging did not finish`, 30_000, "detached");
      await waitNamed(rowPage.locator('[data-virtual-id="message:l999"]'), `${row}: the last history row message:l999 did not mount`, 30_000);
      await waitAtBottom(rowPage, `${row}: the long run did not load pinned at the bottom`);

      // Leave the bottom with real input: the pointer over the timeline, wheel up (less than a page for PageDown).
      const scroll = rowPage.locator('[data-part="timeline-scroll"]');
      const box = await scroll.boundingBox();
      if (!box) throw new Error(`${row}: no scroll viewport`);
      await rowPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await rowPage.mouse.wheel(0, -(gesture === "End" ? 2 : gesture === "PageDown repeated" ? 1.5 : 0.5) * box.height);
      fake.emit({ event: "user_message", session_id: LONG, text: `animated ${engine} ${gesture} away`, mode: "send", attachments: [], delivery_id: `animated-away-${engine}-${gesture}` });
      await waitNamed(rowPage.locator('[data-part="jump-to-latest"][data-unseen-count="1"]'), `${row}: the reader did not leave the bottom (no jump control with unseen=1)`, 10_000);
      const settled = () => rowPage.evaluate(async () => {
        const w = window as typeof window & { __animatedScrolls?: number };
        let seen = -1;
        while (seen !== w.__animatedScrolls) {
          seen = w.__animatedScrolls ?? 0;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
      });
      await rowPage.evaluate(() => {
        const w = window as typeof window & { __animatedScrolls?: number };
        w.__animatedScrolls = 0;
        document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!.addEventListener("scroll", () => { w.__animatedScrolls!++; ((w as any).__times ??= []).push(performance.now()); });
      });
      await settled(); // the wheel-up animation finishes before the counted gesture starts
      await rowPage.evaluate(() => { (window as typeof window & { __animatedScrolls?: number }).__animatedScrolls = 0; });

      {
        // A click on a visible row focuses it; rows handle only arrows, so the browser scrolls the timeline for this key.
        const visibleRow = await rowPage.evaluate(() => {
          const bounds = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!.getBoundingClientRect();
          const row = [...document.querySelectorAll<HTMLElement>("[data-virtual-id]")].find((element) => {
            const box = element.getBoundingClientRect();
            return box.top > bounds.top + 40 && box.bottom < bounds.bottom - 40 && box.height > 20;
          });
          if (!row) return null;
          const box = row.getBoundingClientRect();
          return { x: box.left + 8, y: box.top + box.height / 2 };
        });
        if (!visibleRow) throw new Error(`${row}: no fully visible row to focus`);
        await rowPage.mouse.click(visibleRow.x, visibleRow.y);
        await settled();
        await rowPage.evaluate(() => { (window as typeof window & { __animatedScrolls?: number }).__animatedScrolls = 0; });
        if (gesture === "PageDown (body focus)") await rowPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        if (gesture === "PageDown repeated") {
          const gap = () => scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
          for (let press = 1; press <= 5 && await gap() > 1; press++) {
            await rowPage.evaluate(() => { (window as typeof window & { __animatedScrolls?: number }).__animatedScrolls = 0; });
            await rowPage.keyboard.press("PageDown");
            await settled();
          }
        } else await rowPage.keyboard.press(gesture === "End" ? "End" : "PageDown");
      }
      await rowPage.waitForFunction(() => {
        const element = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
        return element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
      }, undefined, { timeout: 5_000 }).catch(() => { throw new Error(`${row}: the gesture did not reach the end within 5 s`); });
      await settled();
      const callbacks = await rowPage.evaluate(() => (window as typeof window & { __animatedScrolls?: number }).__animatedScrolls ?? 0);
      console.log(`animated ${engine.padEnd(15)} ${gesture.padEnd(8)} ${callbacks} scroll callbacks`);
      const times: number[] = await rowPage.evaluate((n) => ((window as any).__times ?? []).slice(-n), callbacks);
      console.log(`intervals ${gesture} ${times.slice(1).map((t, i) => (t - times[i]!).toFixed(0)).join(",")}`);
      if (callbacks < 2) throw new Error(`${row}: the gesture took ${callbacks} scroll callback(s); it was not animated, so this row proves nothing`);

      const text = `animated ${engine} ${gesture} append`;
      fake.emit({ event: "user_message", session_id: LONG, text, mode: "send", attachments: [], delivery_id: `animated-${engine}-${gesture}` });
      await waitNamed(rowPage.locator('[data-part="timeline"] [data-kind="user"]', { hasText: text }), `${row}: the appended row did not mount`, 5_000, "attached");
      await settled();
      const after = await rowPage.evaluate(() => {
        const element = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
        const engine = (window as typeof window & { __fulcrumVirtual?: { getSnapshot(): { pinned: boolean } } }).__fulcrumVirtual;
        return { gap: element.scrollHeight - element.clientHeight - element.scrollTop, following: engine?.getSnapshot().pinned ?? null, jump: !!document.querySelector('[data-part="jump-to-latest"]') };
      });
      if (after.following !== true || after.jump || after.gap > 1) {
        throw new Error(`${row}: a reader who scrolled down to the end (${callbacks} callbacks) did not follow (follow ${after.following}, jump control ${after.jump ? "shown" : "hidden"}, gap ${after.gap.toFixed(3)} px)`);
      }
    });
  } finally {
    fake.restoreHistory(LONG, history);
  }
}


try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    if (attempt > 600) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  const browser = await firefox.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await warmEngine(page, "firefox");
    for (let run = 1; run <= runs; run++) for (const gesture of ["End", "PageDown"] as const) {
      const t = (tally[gesture] ??= { pass: 0, fail: 0 });
      try { await checkAnimatedReaderScrollRepins(page, "firefox", gesture); t.pass++; console.log(`ok   firefox ${gesture} ${run}/${runs}`); }
      catch (error) { t.fail++; console.log(`FAIL firefox ${gesture} ${run}/${runs}: ${error instanceof Error ? error.message.split("\n")[0] : error}`); }
    }
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM");
  await fake.close();
}
console.log(`RESULT ${JSON.stringify(tally)}`);
process.exit(0);
