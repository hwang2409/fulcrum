import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url);
const port = Number(process.env.SMOKE_PORT ?? 4175);
const paths = (await readdir(root))
  .filter((file) => file.endsWith(".html"))
  .sort()
  .map((file) => file === "index.html" ? "/" : `/${file}`);
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root.pathname,
  stdio: "ignore",
});

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (preview.exitCode !== null) throw new Error("vite preview exited");
    if (await fetch(`http://127.0.0.1:${port}`).then((response) => response.ok).catch(() => false)) break;
    if (attempt === 99) throw new Error("vite preview did not start");
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
      if (errors.length) throw new Error(`${path}: ${errors.join("; ")}`);
      console.log(`ok   ${path}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  if (preview.exitCode === null) {
    preview.kill("SIGTERM");
    await new Promise<void>((resolve) => preview.once("exit", () => resolve()));
  }
}
