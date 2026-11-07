import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";

const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", "4173"], { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" });
const stop = () => preview.kill("SIGTERM");
process.on("exit", stop);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

async function open(count: number, auto = false) {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 720 } });
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(() => {
    const state = ((window as typeof window & { __idle?: { raf: number; timers: number } }).__idle = { raf: 0, timers: 0 });
    const raf = requestAnimationFrame.bind(window);
    const timeout = setTimeout.bind(window);
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => { state.raf++; return raf(callback); }) as typeof requestAnimationFrame;
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => { state.timers++; return timeout(callback, delay, ...args); }) as typeof setTimeout;
  });
  await page.goto(`http://127.0.0.1:4173/virtual.html?count=${count}&virtualDebug=1${auto ? "&auto=1" : ""}`);
  await page.waitForSelector(auto && count <= 200 ? '[data-part="timeline"] > [data-id]' : "[data-virtual-id]");
  return page;
}

async function fps(page: Page) {
  return page.evaluate(async () => {
    let frames = 0;
    let raf = 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => { frames++; if (performance.now() - start >= 1_000) resolve(); else raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
    });
    cancelAnimationFrame(raf);
    return frames / ((performance.now() - start) / 1_000);
  });
}

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch("http://127.0.0.1:4173/virtual.html")).ok) break; } catch {}
    if (attempt === 99) throw new Error("preview did not start");
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
  const results: Array<Record<string, number>> = [];
  for (const count of [5_000, 100_000]) {
    const page = await open(count);
    const mounted = await page.locator("[data-virtual-id]").count();
    assert(mounted <= 201, `${count}: mounted ${mounted} rows`);
    const measuredFps = await fps(page);
    const metrics = await page.evaluate(async () => {
      const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!;
      const controls = (window as typeof window & { __virtualControls: { append(n?: number): void; prepend(n?: number): void; resize(id: string, height: number): void } }).__virtualControls;
      const frames = (count: number) => new Promise<void>((resolve) => { const next = () => count-- <= 0 ? resolve() : requestAnimationFrame(next); next(); });
      scroll.scrollTop = scroll.scrollHeight / 2;
      await frames(3);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const visible = () => [...document.querySelectorAll<HTMLElement>("[data-virtual-id]")].find((row) => row.getBoundingClientRect().top >= scroll.getBoundingClientRect().top)!;
      let anchor = visible();
      const anchorId = anchor.dataset.virtualId!;
      const startTop = anchor.getBoundingClientRect().top;
      const above = [...document.querySelectorAll<HTMLElement>("[data-virtual-id]")].find((row) => row.getBoundingClientRect().bottom <= startTop);
      if (above) controls.resize(above.dataset.virtualId!, 98);
      await frames(4);
      anchor = document.querySelector<HTMLElement>(`[data-virtual-id="${anchorId}"]`)!;
      const resizeError = Math.abs(anchor.getBoundingClientRect().top - startTop);
      if (above) controls.resize(above.dataset.virtualId!, 48);
      await frames(4);
      const splitCorrectionError = Math.abs(anchor.getBoundingClientRect().top - startTop);
      const beforePrependScroll = scroll.scrollTop;
      controls.prepend(20);
      await frames(4);
      const prependScrollDelta = scroll.scrollTop - beforePrependScroll;
      anchor = document.querySelector<HTMLElement>(`[data-virtual-id="${anchorId}"]`)!;
      const prependError = Math.abs(anchor.getBoundingClientRect().top - startTop);
      const focused = anchor;
      focused.focus();
      await frames(1);
      const heldScroll = scroll.scrollTop;
      scroll.scrollTop += 5_000;
      await frames(3);
      const focusAway = document.activeElement === focused;
      scroll.scrollTop = heldScroll;
      await frames(3);
      const focusBack = document.activeElement === focused;
      scroll.scrollTop = scroll.scrollHeight;
      await frames(2);
      controls.append(10);
      await frames(4);
      const bottomError = Math.abs(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight);
      scroll.scrollTop -= 1_000;
      await frames(3);
      const held = visible();
      const heldTop = held.getBoundingClientRect().top;
      controls.append(10);
      await frames(4);
      const unpinnedError = Math.abs(held.getBoundingClientRect().top - heldTop);
      (window as typeof window & { __virtualFollow(): void }).__virtualFollow();
      await frames(4);
      const followRequestError = Math.abs(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight);
      scroll.scrollTop -= 1_000;
      await frames(3);
      controls.append(10);
      await frames(4);
      const jump = document.querySelector<HTMLButtonElement>('[data-part="jump-to-latest"]')!;
      const unseen = Number(jump.dataset.unseenCount);
      const hostPlacement = jump.parentElement?.classList.contains("host-jump-lane") && !document.querySelector('[data-part="timeline-frame"]');
      jump.click();
      await frames(4);
      const jumpBottomError = Math.abs(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const idle = (window as typeof window & { __idle: { raf: number; timers: number } }).__idle;
      const before = { ...idle };
      await new Promise((resolve) => setTimeout(resolve, 300));
      const actions = (globalThis as typeof globalThis & { __fulcrumVirtual: { getActions(): unknown[] } }).__fulcrumVirtual.getActions().slice(-8);
      return { resizeError, splitCorrectionError, prependError, prependScrollDelta, bottomError, unpinnedError, followRequestError, unseen, hostPlacement: Number(hostPlacement), jumpBottomError, focusAway: Number(focusAway), focusBack: Number(focusBack), idleRaf: idle.raf - before.raf, idleTimers: idle.timers - before.timers - 1, actions };
    });
    assert(metrics.resizeError < 1, `${count}: resize anchor error ${metrics.resizeError}`);
    assert(metrics.splitCorrectionError < 1, `${count}: split correction error ${metrics.splitCorrectionError}`);
    assert(metrics.prependError < 1, `${count}: prepend anchor error ${metrics.prependError}, scroll delta ${metrics.prependScrollDelta}, actions ${JSON.stringify(metrics.actions)}`);
    assert(metrics.bottomError < 1, `${count}: bottom follow error ${metrics.bottomError}`);
    assert(metrics.unpinnedError < 1, `${count}: unpinned append error ${metrics.unpinnedError}`);
    assert(metrics.followRequestError < 1, `${count}: follow request error ${metrics.followRequestError}`);
    assert(metrics.unseen === 10, `${count}: unseen count ${metrics.unseen}`);
    assert(metrics.hostPlacement === 1, `${count}: host-owned jump control was not in the host lane`);
    assert(metrics.jumpBottomError < 1, `${count}: jump-to-latest error ${metrics.jumpBottomError}`);
    assert(metrics.focusAway === 1 && metrics.focusBack === 1, `${count}: focus was not retained`);
    assert(metrics.idleRaf === 0, `${count}: ${metrics.idleRaf} idle animation frames`);
    assert(metrics.idleTimers === 0, `${count}: ${metrics.idleTimers} idle timers`);
    results.push({ count, fps: measuredFps, mounted, anchorError: Math.max(metrics.resizeError, metrics.splitCorrectionError, metrics.prependError), idleRaf: metrics.idleRaf, idleTimers: metrics.idleTimers });
    await page.close();
  }
  const crossing = await open(200, true);
  const crossingResult = await crossing.evaluate(async () => {
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!;
    const controls = (window as typeof window & { __virtualControls: { append(n?: number): void } }).__virtualControls;
    scroll.scrollTop = 3_000;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const top = scroll.getBoundingClientRect().top;
    const anchor = [...document.querySelectorAll<HTMLElement>('[data-part="timeline"] > [data-id]')].find((row) => row.getBoundingClientRect().bottom > top)!;
    const id = anchor.dataset.id!;
    const offset = anchor.getBoundingClientRect().top - top;
    controls.append(2);
    for (let index = 0; index < 10; index++) await new Promise(requestAnimationFrame);
    const virtual = document.querySelector<HTMLElement>(`[data-virtual-id="${id}"]`)!;
    return { error: virtual ? Math.abs(virtual.getBoundingClientRect().top - top - offset) : 999, id, mounted: [...document.querySelectorAll<HTMLElement>("[data-virtual-id]")].map((row) => row.dataset.virtualId) };
  });
  assert(crossingResult.error < 1, `mode crossing anchor error ${crossingResult.error}; anchor ${crossingResult.id}; mounted ${crossingResult.mounted.join(",")}`);
  await crossing.close();
  console.table(results);
  console.log("3 browser cases passed (Chromium, 4x CPU throttle; includes automatic mode crossing)");
} finally {
  await browser?.close();
  stop();
  await once(preview, "exit").catch(() => {});
}
