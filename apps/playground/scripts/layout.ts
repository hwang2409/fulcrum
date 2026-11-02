// Fails when the gallery or another playground page scrolls sideways at any common width (the gallery in every theme), when a
// playground page control has no accessible name or is under 44 px tall at touch widths (36 px elsewhere), when a pending approval's actions are hard
// to read or to hit (text contrast below 4.5:1 on the real background, or under 44 px tall at touch widths, 36 px
// elsewhere), when a theme's fg or muted text misses 4.5:1 on its bg, or when a state indicator is hard to see: every
// rendered status word needs 4.5:1 and every state mark and state rail 3:1 against the background it is drawn on, and
// ok, warn, danger, and accent (running) need 3:1 on bg, when a capped output box cuts through a line, or when
// the keyword, string, comment, function, and type token colors are not all distinct. Needs a production build (`bun run build`).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";

const widths = [390, 768, 1024, 1440];
const touchWidth = 860; // the gallery's touch breakpoint
const port = Number(process.env.LAYOUT_PORT ?? 4174); // override when another checkout already serves 4174
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
// Runs in the page. Contrast composites an element's background over its ancestors' until one is opaque.
function pageProblems(minHeight: number) {
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
  const backgroundOf = (start: HTMLElement | null) => {
    const layers: number[][] = [];
    for (let node = start; node; node = node.parentElement) {
      if (layers.at(-1)?.[3] !== 1) layers.push(rgba(getComputedStyle(node).backgroundColor));
    }
    return layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]);
  };
  const contrastOn = (color: string, background: number[]) => {
    const [light, dark] = [luminance(over(rgba(color), background)), luminance(background)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  };
  const problems: string[] = [];
  const cards = [...document.querySelectorAll<HTMLElement>("[data-part=approval][data-state=pending]")];
  if (!cards.length) return ["no pending approval on the page"];
  for (const card of cards) {
  const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
  if (buttons.length !== 2) problems.push(`${card.dataset.id}: ${buttons.length} buttons, expected approve and deny`);
  for (const button of buttons) {
    const name = `${card.dataset.id} ${button.textContent?.trim() || "(unnamed button)"}`;
    let opacity = 1;
    for (let node: HTMLElement | null = button; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    const contrast = contrastOn(getComputedStyle(button).color, backgroundOf(button));
    const height = button.getBoundingClientRect().height;
    if (button.textContent?.trim() === "") problems.push(`${name} has no visible label`);
    if (contrast < 4.5) problems.push(`${name} text contrast ${contrast.toFixed(2)}:1, needs 4.5:1`);
    if (height < minHeight) problems.push(`${name} is ${Math.round(height)} px tall, needs ${minHeight} px`);
    if (opacity < 1) problems.push(`${name} is faded to opacity ${opacity.toFixed(2)}`);
  }
  }
  const root = getComputedStyle(document.documentElement);
  const bg = rgba(root.getPropertyValue("--fulcrum-bg"));
  for (const [name, min] of [["fg", 4.5], ["muted", 4.5], ["ok", 3], ["warn", 3], ["danger", 3], ["accent", 3]] as const) {
    const contrast = contrastOn(root.getPropertyValue(`--fulcrum-${name}`), bg);
    if (contrast < min) problems.push(`--fulcrum-${name} on --fulcrum-bg is ${contrast.toFixed(2)}:1, needs ${min}:1`);
  }
  // The five main syntax roles must each get their own color, so code reads as more than two or three hues.
  const roles = ["keyword", "string", "comment", "function", "type"];
  const colors = roles.map((role) => rgba(root.getPropertyValue(`--fulcrum-tok-${role}`)).join());
  for (let i = 0; i < roles.length; i++)
    for (let j = i + 1; j < roles.length; j++)
      if (colors[i] === colors[j]) problems.push(`--fulcrum-tok-${roles[i]} and --fulcrum-tok-${roles[j]} are the same color`);
  // State indicators as rendered. The neutral rail (border color) of a done tool carries no state, so it is skipped.
  const seen = new Set<string>();
  for (const status of document.querySelectorAll<HTMLElement>("[data-part=tool-status]")) {
    const card = status.closest<HTMLElement>("[data-state]")!;
    const name = `${card.dataset.part} ${card.dataset.id} (${card.dataset.state})`;
    seen.add(`${card.dataset.part}:${card.dataset.state}`);
    const background = backgroundOf(status);
    const word = contrastOn(getComputedStyle(status).color, background);
    if (word < 4.5) problems.push(`${name} status word ${word.toFixed(2)}:1, needs 4.5:1`);
    const mark = getComputedStyle(status, "::before");
    const markColor = rgba(mark.backgroundColor)[3] ? mark.backgroundColor : mark.outlineColor;
    const markContrast = contrastOn(markColor, background);
    if (markContrast < 3) problems.push(`${name} state mark ${markContrast.toFixed(2)}:1, needs 3:1`);
    const rail = getComputedStyle(card).borderLeftColor;
    if (card.dataset.state !== "done") {
      const railContrast = contrastOn(rail, backgroundOf(card.parentElement));
      if (railContrast < 3) problems.push(`${name} state rail ${railContrast.toFixed(2)}:1, needs 3:1`);
    }
  }
  // A capped output or arguments box must cut between lines at its scrolled edge, not through a line's glyphs.
  for (const box of document.querySelectorAll<HTMLElement>("[data-part=tool-output], [data-part=tool-args]")) {
    if (box.scrollHeight <= box.clientHeight) continue;
    const style = getComputedStyle(box);
    const pad = parseFloat(style.flexDirection === "column-reverse" ? style.paddingBottom : style.paddingTop);
    const lines = (box.clientHeight - pad) / parseFloat(style.lineHeight);
    if (Math.abs(lines - Math.round(lines)) > 0.05) problems.push(`${box.dataset.part} in ${box.closest<HTMLElement>("[data-id]")?.dataset.id} shows ${lines.toFixed(2)} lines, cuts through a line`);
  }
  for (const state of ["tool:done", "tool:streaming", "tool:error", "tool:canceled", "approval:pending"]) {
    if (!seen.has(state)) problems.push(`no ${state.replace(":", " in state ")} on the page to check`);
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
  const replay = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await replay.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    (window as typeof window & { __rafRequests: number }).__rafRequests = 0;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      (window as typeof window & { __rafRequests: number }).__rafRequests++;
      return request(callback);
    }) as typeof window.requestAnimationFrame;
  });
  const pageErrors: string[] = [];
  replay.on("pageerror", (error) => pageErrors.push(error.message));
  await replay.goto(`http://127.0.0.1:${port}/`);
  await replay.selectOption("#mode", "zeta:unknown.jsonl");
  await replay.locator("#rate").fill("200");
  await replay.waitForFunction(() => Number(document.querySelector(".mode span")?.textContent?.match(/lap (\d+)/)?.[1] ?? 0) >= 9, undefined, { timeout: 60_000 });
  const rotation = await replay.evaluate(() => ({
    mounted: Boolean(document.querySelector('[data-part="timeline"]')),
    items: Number(document.querySelector('[data-testid="readout"]')?.textContent?.match(/· (\d+) items/)?.[1] ?? -1),
  }));
  if (!rotation.mounted || rotation.items < 0 || rotation.items > 50 || pageErrors.length)
    failures.push(`lap-9 rotation: mounted=${rotation.mounted}, items=${rotation.items}, errors=${pageErrors.join("; ") || "none"}`);
  else console.log(`ok   lap-9 rotation: mounted, ${rotation.items} bounded items, no page errors`);

  await replay.selectOption("#mode", "stress");
  await replay.waitForFunction(() => document.querySelector('[data-virtual-id]')?.getAttribute("aria-setsize") === "5000");
  await replay.selectOption("#mode", "static:100000");
  await replay.waitForFunction(() => document.querySelector('[data-virtual-id]')?.getAttribute("aria-setsize") === "100000");
  await replay.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>(".scroll")!;
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
    const mode = document.querySelector<HTMLSelectElement>("#mode")!;
    mode.append(new Option("test static 201", "static:201"));
    mode.value = "static:201";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await replay.waitForFunction(() => document.querySelector('[data-virtual-id]')?.getAttribute("aria-setsize") === "201");
  await replay.waitForTimeout(250);
  const swap = await replay.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>(".scroll")!;
    return { scrollTop: scroll.scrollTop, maxScroll: scroll.scrollHeight - scroll.clientHeight };
  });
  if (Math.abs(swap.scrollTop - swap.maxScroll) > 1 || pageErrors.length)
    failures.push(`active-scroll store swap: scrollTop=${swap.scrollTop}, maxScroll=${swap.maxScroll}, errors=${pageErrors.join("; ") || "none"}`);
  else console.log(`ok   active-scroll store swap: scrollTop ${swap.scrollTop}, maxScroll ${swap.maxScroll}`);

  await replay.waitForTimeout(500);
  const rafBefore = await replay.evaluate(() => (window as typeof window & { __rafRequests: number }).__rafRequests);
  await replay.waitForTimeout(500);
  const rafAfter = await replay.evaluate(() => (window as typeof window & { __rafRequests: number }).__rafRequests);
  if (rafAfter !== rafBefore) failures.push(`static idle scheduled ${rafAfter - rafBefore} rAF callback(s)`);
  else console.log("ok   static idle scheduled 0 rAF callbacks over 500 ms");
  await replay.close();

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
      for (const problem of await page.evaluate(pageProblems, minHeight)) failures.push(`${theme} @ ${width}: ${problem}`);
    }
    // The other playground pages share one shell: no sideways scroll, and every control is named and big enough to hit.
    for (const path of ["/", "/virtual.html", "/highlight.html"]) {
      await page.goto(`http://127.0.0.1:${port}${path}`);
      await page.waitForSelector(".toolbar");
      const problems = await page.evaluate((minHeight) => {
        const found: string[] = [];
        if (document.documentElement.scrollWidth > innerWidth) found.push(`scrollWidth ${document.documentElement.scrollWidth} > ${innerWidth}`);
        for (const control of document.querySelectorAll<HTMLInputElement>(".shell-bar a, .shell-bar select, .toolbar :is(button, select, input)")) {
          const name = control.getAttribute("aria-label") || [...(control.labels ?? [])].map((label) => label.textContent).join("") || control.textContent;
          const label = `${control.tagName.toLowerCase()} "${name?.trim().slice(0, 24)}"`;
          if (!name?.trim()) found.push(`${control.tagName.toLowerCase()} has no accessible name`);
          if (control.getBoundingClientRect().height < minHeight) found.push(`${label} is ${Math.round(control.getBoundingClientRect().height)} px tall, needs ${minHeight} px`);
        }
        return found;
      }, width <= touchWidth ? 44 : 36);
      for (const problem of problems) failures.push(`${path} @ ${width}: ${problem}`);
      if (!problems.length) console.log(`ok   ${path} @ ${width}`);
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
