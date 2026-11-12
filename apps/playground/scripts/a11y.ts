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
result.versions.axe = axeCore.version;

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
  let gone = false;
  const exited = new Promise<never>((_, reject) => process.child.once("exit", (code, signal) => {
    gone = true; // stops the polling loop below
    reject(new Error(`${name} exited before it was ready (code ${code}, signal ${signal})${process.logs() ? `\n${process.logs()}` : ""}`));
  }));
  const polling = (async () => {
    const end = Date.now() + 15_000;
    while (!gone && Date.now() < end) {
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

// Off-screen timeline rows use `content-visibility: auto` with a 2.5em placeholder (packages/react/styles.css), so
// on an unscrolled page their content overflows the placeholder and overlaps the next card. axe then takes another
// card as the background (false color-contrast) and misjudges overflow (false scrollable-region-focusable). The scan
// forces every row visible, so one axe run sees each row at the size and position a user sees once it renders.
// Scrolling each row into view instead would need one scan per row and still leave the other rows as placeholders.
const realRows = '[data-part="timeline"] > * { content-visibility: visible !important; }';
// Real defects the scan must report. The script adds them to the page only, so no bundle ships them; they sit in
// the last off-screen timeline row, so a scan change that hides real findings there fails the sweep.
const plants = { "color-contrast": "a11y-plant-contrast", "scrollable-region-focusable": "a11y-plant-scroll" } as const;

async function runAxe(page: Page, surface: string, mode: string, plant = false) {
  await page.addStyleTag({ content: realRows });
  await page.addScriptTag({ content: axeSource });
  if (plant) await page.evaluate((ids) => {
    const rows = document.querySelectorAll('[data-part="timeline"] > *');
    const row = rows[rows.length - 1];
    if (!row) throw new Error("no timeline row to hold the planted defects");
    row.insertAdjacentHTML("beforeend", `<p id="${ids["color-contrast"]}" style="color:#767676;background:#8a8a8a;forced-color-adjust:none">planted low-contrast text</p><div id="${ids["scrollable-region-focusable"]}" style="overflow:auto;height:2em"><p style="height:6em;margin:0">planted overflow with no tab stop</p></div>`);
  }, plants);
  const scan = await withDeadline(`axe.run ${surface} ${mode}`, 60_000, page.evaluate(async () => (window as any).axe.run(document, { resultTypes: ["violations", "incomplete"] })));
  const planted = (node: any) => Object.values(plants).some((id) => node.html.includes(`id="${id}"`));
  if (plant) {
    const missed = Object.entries(plants).filter(([rule, id]) => !scan.violations.some((v: any) => v.id === rule && v.nodes.some((n: any) => n.html.includes(`id="${id}"`))));
    if (missed.length) throw new Error(`the sweep missed planted real defects in ${mode}: ${missed.map(([rule]) => rule).join(", ")}`);
  }
  const violations = scan.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.filter((n: any) => !planted(n)).map((n: any) => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })) })).filter((v: any) => v.nodes.length);
  // Incomplete nodes are counted so a finding that moves out of violations stays visible.
  const incomplete = Object.fromEntries(scan.incomplete.map((v: any) => [v.id, v.nodes.filter((n: any) => !planted(n)).length]));
  result.axe.push({ surface, mode, planted: plant ? Object.keys(plants) : [], violations, incomplete });
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
const children = (pid: number) => Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().split("\n").filter(Boolean).map(Number);
// Playwright starts each browser as a direct child of this process (webkit through its pw_run.sh wrapper), so the
// one child that appears during launch is that browser; nothing else is spawned while a browser launches.
async function launch(name: "chromium" | "webkit") {
  const before = new Set(children(process.pid));
  const browser = await (name === "chromium" ? chromium : webkit).launch();
  browsers.add(browser);
  contexts.set(browser, new Set());
  const started = children(process.pid).filter((pid) => !before.has(pid));
  if (started.length === 1) browserPids.set(browser, started[0]!);
  return browser;
}
// Kills the launched process and every descendant, since webkit's real browser runs under the wrapper.
function killTree(pid: number, signal: NodeJS.Signals) {
  const tree = [pid];
  for (let index = 0; index < tree.length; index++) tree.push(...children(tree[index]!));
  for (const target of tree.reverse()) try { process.kill(target, signal); } catch {}
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
  }, browserPids.get(browser), undefined, killTree);
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
    // After the contract checks, so the planted defects never enter the recorded trees.
    await runAxe(p, "playground gallery", cfg.mode, true);
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
    // The fake's live turn ends its setup by asking for approval, so the approve button means the turn has settled.
    await p.locator('[data-part="approval"] button[data-action="approve"]').waitFor({ timeout: 15_000 });
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
    await p.goto(webOrigin, { waitUntil: "networkidle" });
    await p.getByText("no sessions yet", { exact: false }).first().waitFor({ timeout: 15_000 });
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
