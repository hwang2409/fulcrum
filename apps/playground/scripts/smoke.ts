import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url);
const port = Number(process.env.SMOKE_PORT ?? 4175);
const paths = (await readdir(root))
  .filter((file) => file.endsWith(".html"))
  .sort()
  .map((file) => file === "index.html" ? "/" : `/${file}`);
const server = spawn("bun", ["run", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root.pathname,
  stdio: "inherit",
});

try {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (server.exitCode !== null) throw new Error("vite dev server exited");
    if (await fetch(`http://127.0.0.1:${port}`).then((response) => response.ok).catch(() => false)) break;
    if (attempt === 599) throw new Error("vite dev server did not start");
    await Bun.sleep(100);
  }

  const browser = await chromium.launch();
  try {
    for (const path of paths) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      page.on("pageerror", (error) => errors.push(error.message));
      const response = await page.goto(`http://127.0.0.1:${port}${path}`);
      await page.locator("#root > *").first().waitFor({ state: "visible" });
      if (!response?.ok()) errors.push(`HTTP ${response?.status() ?? "no response"}`);
      if (await page.locator("vite-error-overlay").count()) errors.push("vite error overlay is visible");
      if (path === "/virtual.html") {
        await page.getByRole("heading", { name: "virtual timeline" }).waitFor();
        await page.locator(".status").filter({ hasText: "rows" }).waitFor();
        await page.locator('[data-part="message"]').first().waitFor();
      }
      if (path === "/") {
        await page.getByLabel("source").selectOption("demo");
        const code = page.locator('[data-part="md-code-block"] code');
        await code.waitFor();
        await code.locator('[class^="tok-"]').first().waitFor({ timeout: 10_000 });
      }
      if (errors.length) throw new Error(`${path}: ${errors.join("; ")}`);
      console.log(`ok   ${path}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  }
}
