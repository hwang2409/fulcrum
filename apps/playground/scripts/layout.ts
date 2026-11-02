// Fails when the gallery scrolls sideways at any common width in any theme, when a pending approval's actions are hard
// to read or to hit (text contrast below 4.5:1 on the real background, or under 44 px tall at touch widths, 36 px
// elsewhere), or when a theme's fg or muted text misses 4.5:1 on its bg. Needs a production build (`bun run build`).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";

const widths = [390, 768, 1024, 1440];
const touchWidth = 860; // the gallery's touch breakpoint
const port = Number(process.env.LAYOUT_PORT ?? 4174); // override when another checkout already serves 4174
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
// Runs in the page. Contrast composites the button's background over its ancestors' until one is opaque.
function approvalProblems(minHeight: number) {
  const pixel = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
  const rgba = (color: string) => {
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = color;
    pixel.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top: number[], bottom: number[]) => top.slice(0, 3).map((c, i) => c * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const luminance = (c: number[]) =>
    c.slice(0, 3).map((v) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const problems: string[] = [];
  const cards = [...document.querySelectorAll<HTMLElement>("[data-part=approval][data-state=pending]")];
  if (!cards.length) return ["no pending approval on the page"];
  for (const card of cards) {
  const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
  if (buttons.length !== 2) problems.push(`${card.dataset.id}: ${buttons.length} buttons, expected approve and deny`);
  for (const button of buttons) {
    const name = `${card.dataset.id} ${button.textContent?.trim() || "(unnamed button)"}`;
    const layers: number[][] = [];
    let opacity = 1;
    for (let node: HTMLElement | null = button; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      if (layers.at(-1)?.[3] !== 1) layers.push(rgba(style.backgroundColor));
    }
    const background = layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]);
    const [light, dark] = [luminance(over(rgba(getComputedStyle(button).color), background)), luminance(background)].sort((a, b) => b - a);
    const contrast = (light + 0.05) / (dark + 0.05);
    const height = button.getBoundingClientRect().height;
    if (button.textContent?.trim() === "") problems.push(`${name} has no visible label`);
    if (contrast < 4.5) problems.push(`${name} text contrast ${contrast.toFixed(2)}:1, needs 4.5:1`);
    if (height < minHeight) problems.push(`${name} is ${Math.round(height)} px tall, needs ${minHeight} px`);
    if (opacity < 1) problems.push(`${name} is faded to opacity ${opacity.toFixed(2)}`);
  }
  }
  const root = getComputedStyle(document.documentElement);
  const bg = rgba(root.getPropertyValue("--fulcrum-bg"));
  for (const name of ["fg", "muted"]) {
    const [light, dark] = [luminance(over(rgba(root.getPropertyValue(`--fulcrum-${name}`)), bg)), luminance(bg)].sort((a, b) => b - a);
    const contrast = (light + 0.05) / (dark + 0.05);
    if (contrast < 4.5) problems.push(`--fulcrum-${name} on --fulcrum-bg is ${contrast.toFixed(2)}:1, needs 4.5:1`);
  }
  return problems;
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const failures: string[] = [];
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/gallery.html`)).ok) break; } catch {}
    if (preview.exitCode !== null || i === 100) throw new Error("vite preview did not start");
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
  let themes: string[] = [];
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    if (!themes.length) {
      await page.goto(`http://127.0.0.1:${port}/gallery.html`);
      // The picker lists every theme in the shipped themes.css.
      themes = await page.$$eval("#theme option", (options) => options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== "auto"));
      if (themes.length < 12) throw new Error(`expected at least 12 themes in the picker, found ${themes.length}`);
    }
    for (const theme of themes) {
      await page.goto(`http://127.0.0.1:${port}/gallery.html?theme=${theme}`);
      await page.waitForSelector('[data-part="tool"]');
      // Names the widest element that pokes past the viewport, so a failure points at its cause.
      const result = await page.evaluate(() => {
        const viewport = innerWidth;
        let culprit = "";
        let right = viewport;
        for (const node of document.querySelectorAll<HTMLElement>("body *")) {
          const edge = node.getBoundingClientRect().right;
          if (edge > right + 0.5) [right, culprit] = [edge, `${node.tagName.toLowerCase()}.${node.className || node.getAttribute("data-part") || ""}`];
        }
        return { scroll: document.documentElement.scrollWidth, viewport, culprit, right: Math.round(right) };
      });
      const line = `${theme} @ ${width}: scrollWidth ${result.scroll}, innerWidth ${result.viewport}`;
      if (result.scroll > result.viewport) failures.push(`${line} (widest: ${result.culprit} to ${result.right}px)`);
      else console.log(`ok   ${line}`);
      const minHeight = width <= touchWidth ? 44 : 36;
      for (const problem of await page.evaluate(approvalProblems, minHeight)) failures.push(`${theme} @ ${width}: ${problem}`);
    }
    await page.close();
  }
} finally {
  await browser?.close();
  preview.kill("SIGTERM");
  await once(preview, "exit").catch(() => {});
}
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
