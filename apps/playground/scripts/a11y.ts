import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import axeCore from "axe-core";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startFakeZeta } from "../../web/scripts/fake-zeta.js";
import { closeBrowser, stopChild, withDeadline } from "./lifecycle";

const root = resolve(import.meta.dir, "../../..");
const bun = process.execPath;
const axeSource = axeCore.source;
const output = resolve(process.cwd(), process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) || "a11y-results.json");
const result: any = { revision: Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim(), date: new Date().toISOString(), versions: {} as any, axe: [] as any[], contracts: [] as any[], trees: [] as any[] };
result.versions.bun = Bun.version;
result.versions.playwright = (await import("playwright/package.json", { with: { type: "json" } })).default.version;
result.versions.axe = "4.11.1";

async function freePort() {
  const socket = createServer();
  await withDeadline("reserve free port", 2_000, new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  }), () => socket.close());
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("could not select a free port");
  await withDeadline("release free port", 2_000, new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve())));
  return address.port;
}

function server(cwd: string, port: number, env: Record<string, string> = {}) {
  const child = spawn(bun, ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer) => { output = `${output}${chunk}`.slice(-4_000); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, logs: () => output.trim() };
}

async function ready(name: string, url: string, marker: string, process: ReturnType<typeof server>) {
  const exited = new Promise<never>((_, reject) => process.child.once("exit", (code, signal) => {
    reject(new Error(`${name} exited before it was ready (code ${code}, signal ${signal})${process.logs() ? `\n${process.logs()}` : ""}`));
  }));
  const polling = (async () => {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const controller = new AbortController();
      try {
        const response = await withDeadline(`${name} readiness fetch`, 1_000, (async () => {
          const fetched = await fetch(url, { signal: controller.signal });
          return { ok: fetched.ok, body: await fetched.text() };
        })(), () => controller.abort());
        if (response.ok && response.body.includes(marker)) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error(`${name} did not serve its expected page at ${url}`);
  })();
  await Promise.race([polling, exited]);
}

async function runAxe(page: Page, surface: string, mode: string) {
  await page.addScriptTag({ content: axeSource });
  const scan = await page.evaluate(async () => (window as any).axe.run(document, { resultTypes: ["violations"] }));
  result.axe.push({ surface, mode, violations: scan.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n: any) => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })) })) });
}
async function contract(page: Page, browserName: string, surface: string) {
  const values = await page.evaluate(() => {
    const timeline = document.querySelector('[data-part="timeline"]');
    const approval = document.querySelector('[data-part="approval"]');
    const buttons = approval ? [...approval.querySelectorAll("button")].map((button) => ({ text: button.textContent?.trim(), disabled: button.getAttribute("aria-disabled"), describedby: button.getAttribute("aria-describedby") })) : [];
    const sub = document.querySelector('[data-part="sub-agent"]');
    const rowError = document.querySelector('[data-row-error]');
    const skip = document.querySelector('[data-part="jump-to-approval"]');
    const live = document.querySelector('[data-part="timeline-live"]');
    return {
      log: timeline ? { role: timeline.getAttribute("role"), name: timeline.getAttribute("aria-label"), live: timeline.getAttribute("aria-live") } : null,
      approval: approval ? { role: approval.getAttribute("role"), name: approval.getAttribute("aria-label"), labelledby: approval.getAttribute("aria-labelledby"), buttons } : null,
      subAgent: sub ? { tag: sub.tagName, role: sub.getAttribute("role"), name: sub.getAttribute("aria-label"), text: sub.textContent?.trim() } : null,
      rowError: rowError?.textContent?.trim() ?? null,
      approvalSkip: skip ? { text: skip.textContent?.trim(), href: skip.getAttribute("href") } : null,
      announcer: live?.textContent?.trim() ?? null,
    };
  });
  result.contracts.push({ browser: browserName, surface, ...values });
  result.trees.push({ browser: browserName, surface, snapshot: await page.locator("body").ariaSnapshot({ timeout: 10_000 }) });
}

const browsers = new Set<Browser>();
const contexts = new Map<Browser, Set<BrowserContext>>();
const browserPids = new Map<Browser, number>();
async function launch(name: "chromium" | "webkit") {
  const browser = await (name === "chromium" ? chromium : webkit).launch();
  browsers.add(browser);
  contexts.set(browser, new Set());
  if (name === "chromium") {
    const { processInfo } = await (await browser.newBrowserCDPSession()).send("SystemInfo.getProcessInfo");
    const pid = processInfo.find((info) => info.type === "browser")?.id;
    if (pid) browserPids.set(browser, pid);
  }
  return browser;
}
async function page(browser: Browser, options: Parameters<Browser["newPage"]>[0]) {
  const opened = await browser.newPage(options);
  contexts.get(browser)!.add(opened.context());
  return opened;
}
async function closeTrackedBrowser(browser: Browser) {
  await closeBrowser("a11y cleanup: browser.close", async () => {
    for (const context of contexts.get(browser) ?? []) await context.close();
    await browser.close();
  }, browserPids.get(browser));
  browsers.delete(browser);
  contexts.delete(browser);
  browserPids.delete(browser);
}

let galleryServer: ReturnType<typeof server> | undefined;
let fake: Awaited<ReturnType<typeof startFakeZeta>> | undefined;
let webServer: ReturnType<typeof server> | undefined;
try {
  const galleryPort = await freePort();
  galleryServer = server(`${root}/apps/playground`, galleryPort);
  await ready("playground vite", `http://127.0.0.1:${galleryPort}/gallery.html`, "<title>fulcrum component gallery</title>", galleryServer);
  const c = await launch("chromium");
  result.versions.chromium = c.version();
  for (const cfg of [
    { mode: "light-1440", width: 1440, colorScheme: "light" as const, forcedColors: "none" as const },
    { mode: "dark-1440", width: 1440, colorScheme: "dark" as const, forcedColors: "none" as const },
    { mode: "forced-colors-1440", width: 1440, colorScheme: "light" as const, forcedColors: "active" as const },
    { mode: "light-390", width: 390, colorScheme: "light" as const, forcedColors: "none" as const },
  ]) {
    const p = await page(c, { viewport: { width: cfg.width, height: 900 }, colorScheme: cfg.colorScheme, forcedColors: cfg.forcedColors, reducedMotion: "reduce" });
    await p.goto(`http://127.0.0.1:${galleryPort}/gallery.html`, { waitUntil: "networkidle" });
    await runAxe(p, "playground gallery", cfg.mode);
    if (cfg.mode === "light-1440") {
      await contract(p, "chromium", "playground gallery");
      const skip = p.locator('#approval-write [data-part="jump-to-approval"]');
      await skip.focus();
      const focusOrder = [await skip.textContent()];
      await skip.press("Enter");
      focusOrder.push(await p.locator(":focus").textContent());
      await p.keyboard.press("Tab");
      focusOrder.push(await p.locator(":focus").textContent());
      result.contracts.push({ browser: "chromium", surface: "playground approval focus order", focusOrder });
    }
    await p.close();
  }
  await closeTrackedBrowser(c);
  const w = await launch("webkit");
  result.versions.webkit = w.version();
  const gp = await page(w, { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await gp.goto(`http://127.0.0.1:${galleryPort}/gallery.html`, { waitUntil: "networkidle" });
  await contract(gp, "webkit", "playground gallery");
  await gp.close();
  await closeTrackedBrowser(w);

  const webPort = await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  fake = await startFakeZeta({ origins: [webOrigin], live: true, approvalReconnectGraceMs: 0 });
  webServer = server(`${root}/apps/web`, webPort, { ZETA_HOME: fake.home });
  await ready("web vite", webOrigin, "<title>zeta · fulcrum</title>", webServer);
  for (const engine of ["chromium", "webkit"] as const) {
    const b = await launch(engine);
    const p = await page(b, { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await p.goto(webOrigin, { waitUntil: "networkidle" });
    await p.waitForSelector('[data-part="timeline"]', { timeout: 15_000 });
    await p.waitForTimeout(1_800);
    const historyAnnouncer = await p.locator('[data-part="timeline-live"]').textContent();
    for (let index = 0; index < 4; index++) fake.emit({
      event: "sub_agent_receipt",
      session_id: "s-reconnect",
      data: { notification_id: `a11y-${engine}-${index}`, kind: "agent_completion", child_instance_id: `a11y-child-${index}`, description: "accessibility worker", status: "completed", text: `accessibility worker ${index + 1} finished`, summary: `accessibility worker ${index + 1} finished` },
    });
    await p.locator('[data-part="timeline-live"]').getByText("4 new items", { exact: true }).waitFor({ timeout: 5_000 });
    await contract(p, engine, "apps/web running + tools + approval + history");
    result.contracts.push({ browser: engine, surface: "apps/web history announcement", beforeAppend: historyAnnouncer, afterAppend: await p.locator('[data-part="timeline-live"]').textContent() });
    if (engine === "chromium") {
      await runAxe(p, "apps/web running + tools + approval + history", "light-1440");
      await p.emulateMedia({ colorScheme: "dark" }); await runAxe(p, "apps/web running + tools + approval + history", "dark-1440");
      await p.emulateMedia({ forcedColors: "active", colorScheme: "light" }); await runAxe(p, "apps/web running + tools + approval + history", "forced-colors-1440");
      await p.setViewportSize({ width: 390, height: 844 }); await p.emulateMedia({ forcedColors: "none" }); await runAxe(p, "apps/web running + tools + approval + history", "light-390");
    }
    await closeTrackedBrowser(b);
  }
  fake.setEmpty(true);
  for (const engine of ["chromium", "webkit"] as const) {
    const b = await launch(engine);
    const p = await page(b, { viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await p.goto(webOrigin, { waitUntil: "networkidle" }); await p.waitForTimeout(1_000);
    await contract(p, engine, "apps/web empty");
    if (engine === "chromium") await runAxe(p, "apps/web empty", "light-390");
    await closeTrackedBrowser(b);
  }
} finally {
  for (const browser of [...browsers]) await closeTrackedBrowser(browser).catch((error) => { console.error(String(error)); process.exitCode = 1; });
  if (webServer) await stopChild("a11y cleanup: web vite", webServer.child).catch((error) => { console.error(String(error)); process.exitCode = 1; });
  if (fake) await withDeadline("a11y cleanup: fake zeta", 10_000, fake.close()).catch((error) => { console.error(String(error)); process.exitCode = 1; });
  if (galleryServer) await stopChild("a11y cleanup: playground vite", galleryServer.child).catch((error) => { console.error(String(error)); process.exitCode = 1; });
  await withDeadline("a11y cleanup: write report", 10_000, writeFile(output, JSON.stringify(result, null, 2))).catch((error) => { console.error(String(error)); process.exitCode = 1; });
}
console.log(`wrote ${output}`);
console.log(JSON.stringify({ axe: result.axe.map((x: any) => ({ surface: x.surface, mode: x.mode, violations: x.violations.map((v: any) => `${v.id}:${v.nodes.length}`) })), contracts: result.contracts }, null, 2));
