// Screenshots of every gallery Mermaid card, streaming and done, at 1440, 768, and 390 px, in a dark and a light theme.
// OUT sets the folder (default ~/.zeta/scratch/fulcrum-mermaid); THEMES a comma list. Runs vite's dev server.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

const port = Number(process.env.SHOTS_PORT ?? 4192);
const out = process.env.OUT ?? `${homedir()}/.zeta/scratch/fulcrum-mermaid`;
const themes = (process.env.THEMES ?? "tokyo-night,github-light").split(",");
await mkdir(out, { recursive: true });
const server = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
try {
  for (let attempt = 0; ; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/gallery.html`).then((r) => r.ok).catch(() => false)) break;
    if (attempt > 600) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  const browser = await chromium.launch();
  try {
    for (const theme of themes) for (const width of [1440, 768, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto(`http://127.0.0.1:${port}/gallery.html?theme=${theme}#Mermaid`);
      await page.locator("#mermaid-flowchart-done").waitFor();
      for (const card of await page.locator('article[id^="mermaid-"]').all()) {
        const id = (await card.getAttribute("id"))!;
        if (id === "mermaid-live") continue;
        await card.scrollIntoViewIfNeeded();
        if (id.endsWith("-done")) await card.locator(id === "mermaid-invalid-done" ? "[data-part=mermaid-error]" : "[data-part=mermaid-diagram] svg").waitFor({ timeout: 30_000 });
        await card.screenshot({ path: `${out}/${id}-${width}-${theme}.png` });
      }
      if (errors.length) console.error(`${theme} ${width}: ${errors.join("; ")}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`screenshots in ${out}`);
} finally {
  server.kill();
}
