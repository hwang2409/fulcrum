import { chromium, webkit, type Page } from "playwright";
import axeCore from "axe-core";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startFakeZeta } from "../../web/scripts/fake-zeta.js";

const root = resolve(import.meta.dir, "../../..");
const bun = process.execPath;
const axeSource = axeCore.source;
const output = resolve(process.cwd(), process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) || "a11y-results.json");
const result: any = { revision: Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim(), date: new Date().toISOString(), versions: {} as any, axe: [] as any[], contracts: [] as any[], trees: [] as any[] };
result.versions.bun = Bun.version;
result.versions.playwright = (await import("playwright/package.json", { with: { type: "json" } })).default.version;
result.versions.axe = "4.11.1";

async function ready(url: string) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`server not ready: ${url}`);
}
function server(cwd: string, port: number, env: Record<string, string> = {}) {
  const proc = Bun.spawn([bun, "x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return proc;
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

const galleryPort = 5411;
const galleryServer = server(`${root}/apps/playground`, galleryPort);
let fake: Awaited<ReturnType<typeof startFakeZeta>> | undefined;
let webServer: ReturnType<typeof server> | undefined;
try {
  await ready(`http://127.0.0.1:${galleryPort}/gallery.html`);
  const c = await chromium.launch();
  result.versions.chromium = c.version();
  for (const cfg of [
    { mode: "light-1440", width: 1440, colorScheme: "light" as const, forcedColors: "none" as const },
    { mode: "dark-1440", width: 1440, colorScheme: "dark" as const, forcedColors: "none" as const },
    { mode: "forced-colors-1440", width: 1440, colorScheme: "light" as const, forcedColors: "active" as const },
    { mode: "light-390", width: 390, colorScheme: "light" as const, forcedColors: "none" as const },
  ]) {
    const p = await c.newPage({ viewport: { width: cfg.width, height: 900 }, colorScheme: cfg.colorScheme, forcedColors: cfg.forcedColors, reducedMotion: "reduce" });
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
  await c.close();
  const w = await webkit.launch();
  result.versions.webkit = w.version();
  const gp = await w.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await gp.goto(`http://127.0.0.1:${galleryPort}/gallery.html`, { waitUntil: "networkidle" });
  await contract(gp, "webkit", "playground gallery");
  await gp.close(); await w.close();

  const webPort = 5412;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  fake = await startFakeZeta({ origins: [webOrigin], live: true, approvalReconnectGraceMs: 0 });
  webServer = server(`${root}/apps/web`, webPort, { ZETA_HOME: fake.home });
  await ready(webOrigin);
  for (const engine of [{ name: "chromium", launch: chromium.launch.bind(chromium) }, { name: "webkit", launch: webkit.launch.bind(webkit) }]) {
    const b = await engine.launch();
    const p = await b.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await p.goto(webOrigin, { waitUntil: "networkidle" });
    await p.waitForSelector('[data-part="timeline"]', { timeout: 15_000 });
    await p.waitForTimeout(1800);
    const historyAnnouncer = await p.locator('[data-part="timeline-live"]').textContent();
    for (let index = 0; index < 3; index++) fake.emit({
      event: "sub_agent_receipt",
      session_id: "s-reconnect",
      data: { notification_id: `a11y-${engine.name}-${index}`, kind: "agent_completion", child_instance_id: `a11y-child-${index}`, description: "accessibility worker", status: "completed", text: `accessibility worker ${index + 1} finished`, summary: `accessibility worker ${index + 1} finished` },
    });
    await p.waitForTimeout(1_100);
    await contract(p, engine.name, "apps/web running + tools + approval + history");
    result.contracts.push({ browser: engine.name, surface: "apps/web history announcement", beforeAppend: historyAnnouncer, afterAppend: await p.locator('[data-part="timeline-live"]').textContent() });
    if (engine.name === "chromium") {
      await runAxe(p, "apps/web running + tools + approval + history", "light-1440");
      await p.emulateMedia({ colorScheme: "dark" }); await runAxe(p, "apps/web running + tools + approval + history", "dark-1440");
      await p.emulateMedia({ forcedColors: "active", colorScheme: "light" }); await runAxe(p, "apps/web running + tools + approval + history", "forced-colors-1440");
      await p.setViewportSize({ width: 390, height: 844 }); await p.emulateMedia({ forcedColors: "none" }); await runAxe(p, "apps/web running + tools + approval + history", "light-390");
    }
    await b.close();
  }
  fake.setEmpty(true);
  for (const engine of [{ name: "chromium", launch: chromium.launch.bind(chromium) }, { name: "webkit", launch: webkit.launch.bind(webkit) }]) {
    const b = await engine.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await p.goto(webOrigin, { waitUntil: "networkidle" }); await p.waitForTimeout(1000);
    await contract(p, engine.name, "apps/web empty");
    if (engine.name === "chromium") await runAxe(p, "apps/web empty", "light-390");
    await b.close();
  }
} finally {
  if (webServer) { webServer.kill(); await webServer.exited; }
  if (fake) await fake.close();
  galleryServer.kill(); await galleryServer.exited;
  await writeFile(output, JSON.stringify(result, null, 2));
}
console.log(`wrote ${output}`);
console.log(JSON.stringify({ axe: result.axe.map((x: any) => ({ surface: x.surface, mode: x.mode, violations: x.violations.map((v: any) => `${v.id}:${v.nodes.length}`) })), contracts: result.contracts }, null, 2));
