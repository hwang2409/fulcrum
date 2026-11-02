import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
const out = "/Users/henry/.zeta/scratch/fulcrum-playground-polish-1";
const port = 4187;
const base = `http://127.0.0.1:${port}`;
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
const browser = await (async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) break; } catch {} await Bun.sleep(100); } return chromium.launch(); })();
const log = (...a: unknown[]) => console.log(...a);
const errors: string[] = [];
const open = async (path: string, width: number) => {
  const page = await browser.newPage({ viewport: { width, height: width > 500 ? 900 : 844 }, reducedMotion: "reduce" });
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${path}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${path}: ${e.message}`));
  await page.goto(base + path);
  return page;
};
const topOf = (page: Page) => page.evaluate(() => {
  const scroll = document.querySelector<HTMLElement>(".scroll")!;
  const top = scroll.getBoundingClientRect().top;
  const row = [...scroll.querySelectorAll<HTMLElement>("[data-virtual-id]")].sort((a, b) => +a.dataset.virtualIndex! - +b.dataset.virtualIndex!).find((r) => r.getBoundingClientRect().bottom > top)!;
  return { id: row.dataset.virtualId!, top: row.getBoundingClientRect().top };
});
try {
  for (const theme of ["gruvbox-dark", "github-light"]) for (const width of [1440, 390]) {
    for (const [name, path] of [["playground", "/"], ["virtual", "/virtual.html?count=100000"], ["highlight", "/highlight.html"]] as const) {
      const page = await open(`${path}${path.includes("?") ? "&" : "?"}theme=${theme}`, width);
      await page.waitForTimeout(name === "playground" ? 4000 : 1500);
      if (name === "playground") { await page.$eval(".scroll", (s) => (s.scrollTop = 200)); await page.waitForTimeout(1500); }
      await page.screenshot({ path: `${out}/${name}-${theme}-${width}.png`, fullPage: name === "highlight" });
      await page.close();
    }
  }
  // Follow and unseen on / (fixture replay, then stress).
  for (const mode of ["", "stress"]) {
    const page = await open("/?theme=gruvbox-dark", 1440);
    if (mode) await page.selectOption("#mode", mode);
    await page.waitForTimeout(4000);
    const pinned = await page.$eval(".scroll", (s) => s.scrollHeight - s.scrollTop - s.clientHeight);
    await page.$eval(".scroll", (s) => (s.scrollTop = Math.max(0, s.scrollTop - 600)));
    await page.waitForTimeout(2500);
    const jump = await page.$eval('[data-part="jump-to-latest"]', (b) => ({ text: b.textContent, h: b.getBoundingClientRect().height, visible: b.getBoundingClientRect().bottom <= innerHeight })).catch(() => null);
    const status = await page.$eval(".status", (s) => s.textContent);
    await page.screenshot({ path: `${out}/playground-${mode || "replay"}-unseen-gruvbox-dark-1440.png` });
    await page.click('[data-part="jump-to-latest"]').catch(() => {});
    await page.waitForTimeout(300);
    const after = await page.$eval(".scroll", (s) => s.scrollHeight - s.scrollTop - s.clientHeight);
    log(`/ ${mode || "replay"}: pinned gap ${pinned}, jump ${JSON.stringify(jump)}, after jump gap ${after}, status "${status}"`);
    await page.close();
  }
  // Anchoring, focus, stream, debug on virtual.html.
  const page = await open("/virtual.html?count=100000&theme=github-light", 1440);
  await page.waitForSelector("[data-virtual-id]");
  await page.$eval(".scroll", (s) => (s.scrollTop = s.scrollHeight / 2));
  await page.waitForTimeout(400);
  for (const action of ["insert 5 above", "resize above", "resize above", "prepend 20", "append 10"]) {
    const before = await topOf(page);
    await page.getByRole("button", { name: action, exact: true }).click();
    await page.waitForTimeout(300);
    const row = await page.$eval(`[data-virtual-id="${before.id}"]`, (r) => r.getBoundingClientRect().top);
    log(`virtual ${action}: anchor ${before.id} moved ${(row - before.top).toFixed(2)} px`);
  }
  await page.getByRole("button", { name: "debug overlay" }).click();
  await page.waitForTimeout(300);
  log("debug overlay shown:", await page.locator('[data-part="virtual-debug"]').count());
  await page.screenshot({ path: `${out}/virtual-debug-github-light-1440.png` });
  await page.getByRole("button", { name: "debug overlay" }).click();
  await page.waitForTimeout(200);
  log("debug overlay after off:", await page.locator('[data-part="virtual-debug"]').count());
  await page.$eval(".scroll", (s) => (s.scrollTop = s.scrollHeight));
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "stream" }).click();
  await page.waitForTimeout(1500);
  log("stream pinned gap", await page.$eval(".scroll", (s) => s.scrollHeight - s.scrollTop - s.clientHeight));
  await page.$eval(".scroll", (s) => (s.scrollTop -= 1000));
  await page.waitForTimeout(1500);
  log("stream unseen", await page.$eval('[data-part="jump-to-latest"]', (b) => b.textContent).catch(() => "none"));
  await page.screenshot({ path: `${out}/virtual-stream-unseen-github-light-1440.png` });
  await page.getByRole("button", { name: "stream" }).click();
  // Keyboard: tab to a row and arrow down.
  const first = await topOf(page);
  await page.focus(`[data-virtual-id="${first.id}"]`);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  log("arrow down focus:", first.id, "->", await page.evaluate(() => (document.activeElement as HTMLElement).dataset.virtualId), "outline", await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle + " " + getComputedStyle(document.activeElement!).outlineWidth));
  await page.close();
  // Controls on / at 390: names, height, focus ring.
  const mobile = await open("/?theme=gruvbox-dark", 390);
  const controls = await mobile.$$eval(".shell-bar a, .shell-bar select, .toolbar button, .toolbar select, .toolbar input", (els) => els.map((el) => {
    const input = el as HTMLInputElement;
    const name = el.getAttribute("aria-label") || [...(input.labels ?? [])].map((l) => l.textContent?.trim()).join(" ") || el.textContent?.trim();
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} name="${name}" h=${Math.round(el.getBoundingClientRect().height)}`;
  }));
  log(controls.join("\n"));
  const rings: string[] = [];
  for (let i = 0; i < 9; i++) { await mobile.keyboard.press("Tab"); rings.push(await mobile.evaluate(() => { const a = document.activeElement as HTMLElement; const s = getComputedStyle(a); return `${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}:${s.outlineStyle} ${s.outlineWidth}`; })); }
  log("tab:", rings.join(" | "));
  log("overflow 390:", await mobile.evaluate(() => document.documentElement.scrollWidth));
  await mobile.close();
} finally {
  log("errors:", errors.length ? errors.join("\n") : "none");
  await browser.close();
  preview.kill("SIGTERM");
}
