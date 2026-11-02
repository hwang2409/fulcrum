import { chromium } from "playwright";
import { spawn } from "node:child_process";
const port = 4191;
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: "ignore" });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/gallery.html`)).ok) break; } catch {} await Bun.sleep(200); }
const browser = await chromium.launch();
try {
  for (const fixture of ["edit", "search"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/gallery.html?viewerFixture=${fixture}`);
    const button = page.getByRole("button", { name: /^open all/ });
    await button.waitFor(); await button.click();
    const viewer = page.locator('[data-part="text-viewer"]'); await viewer.waitFor(); await page.waitForTimeout(1500);
    const sel = fixture === "edit"
      ? { tokens: "[class^=tok-]", inserted: '[data-part="diff-line"][data-change="insert"]', deleted: '[data-part="diff-line"][data-change="delete"]', marks: 'mark[data-part="diff-word"]' }
      : { tokens: "[class^=tok-]", heads: '[data-part="search-head"]', lines: '[data-part="line"][data-match]', marks: 'mark[data-part="search-match"]' };
    console.log(fixture, JSON.stringify(await viewer.evaluate((node, s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, node.querySelectorAll(v).length])), sel)));
    await page.close();
  }
} finally { await browser.close(); preview.kill("SIGTERM"); }
