// Fails when the gallery or another playground page scrolls sideways at any common width (the gallery in every theme), when a
// playground page control has no accessible name or is under 44 px tall at touch widths (36 px elsewhere), when a pending approval's actions are hard
// to read or to hit (text contrast below 4.5:1 on the real background, or under 44 px tall at touch widths, 36 px
// elsewhere), when a theme's fg or muted text misses 4.5:1 on its bg, or when a state indicator is hard to see: every
// rendered status word needs 4.5:1 and every state mark and state rail 3:1 against the background it is drawn on, and
// ok, warn, danger, and accent (running) need 3:1 on bg, when a capped output box cuts through a line, or when
// the keyword, string, comment, function, and type token colors are not all distinct. Every visible text inside the
// parts (labels drawn by ::before/::after too) must reach 4.5:1 on the background it is drawn on, in every theme; text in
// a syntax or ANSI color (--fulcrum-tok-*, --fulcrum-ansi-*: code, terminal output, tool-header paths and numbers), or
// on an ANSI background, must reach 3:1, the floor for official palette colors (packages/react/themes.css). Every button, summary, and
// a[role=button] inside the parts must be a styled fulcrum control, with no browser-default appearance, ButtonFace
// background, default border, or system font, at rest and under forced :hover, :focus, :focus-visible, and :active. The large-output viewer opens in <16 ms, follows the bottom, and highlights a
// 1,000,000-line file with no long tasks; scrolling it under 4x CPU throttling is reported. Needs a production build
// (`bun run build`). Collapsed tool bodies warm before they open (see warm-check.ts).
import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { checkWarmBodies } from "./warm-check.js";

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
  const buttons = [...card.querySelectorAll<HTMLButtonElement>("[data-part=approval-actions] button")];
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
  for (const box of document.querySelectorAll<HTMLElement>("[data-part=tool-output], [data-part=tool-args], [data-part=tool-lines], [data-part=tool-diff], [data-part=tool-matches]")) {
    if (box.scrollHeight <= box.clientHeight) continue;
    const style = getComputedStyle(box);
    const pad = parseFloat(style.flexDirection === "column-reverse" ? style.paddingBottom : style.paddingTop);
    const lines = (box.clientHeight - pad) / parseFloat(style.lineHeight);
    if (Math.abs(lines - Math.round(lines)) > 0.05) problems.push(`${box.dataset.part} in ${box.closest<HTMLElement>("[data-id]")?.dataset.id} shows ${lines.toFixed(2)} lines, cuts through a line`);
  }
  // Every visible text in the parts, and the text labels drawn by ::before and ::after, at 4.5:1 on what is behind it, or
  // 3:1 when it is drawn in a syntax or ANSI color, or on an ANSI background (.ansi-has-bg: bg text on that color).
  const syntax = new Set([
    ...["keyword", "string", "number", "comment", "function", "type", "variable", "constant", "operator", "punctuation", "tag", "attribute", "regexp", "inserted", "deleted"].map((name) => `tok-${name}`),
    ...["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap((name) => [`ansi-${name}`, `ansi-bright-${name}`]),
  ].map((name) => rgba(root.getPropertyValue(`--fulcrum-${name}`)).join()));
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (node: Element) => styles.get(node) ?? styles.set(node, getComputedStyle(node)).get(node)!;
  const opacityOf = (node: Element | null) => {
    let opacity = 1;
    for (; node; node = node.parentElement) opacity *= Number(style(node).opacity);
    return opacity;
  };
  const textProblems = new Map<string, string>();
  const checkText = (node: HTMLElement, color: string, sample: string) => {
    const [r, g, b, a] = rgba(color);
    const ratio = contrastOn(`rgba(${r}, ${g}, ${b}, ${a! * opacityOf(node)})`, backgroundOf(node));
    const min = syntax.has([r, g, b, a].join()) || node.classList.contains("ansi-has-bg") ? 3 : 4.5;
    if (ratio >= min) return;
    const where = node.closest<HTMLElement>("[data-part]");
    const key = `${where?.dataset.part}.${node.className || node.tagName.toLowerCase()} ${color}`;
    if (!textProblems.has(key)) textProblems.set(key, `text "${sample.trim().slice(0, 24)}" (${key}) is ${ratio.toFixed(2)}:1, needs ${min}:1`);
  };
  for (const timeline of document.querySelectorAll<HTMLElement>('[data-part="timeline"]')) {
    const walker = document.createTreeWalker(timeline, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const node = text.parentElement!;
      if (!text.textContent!.trim() || !node.getClientRects().length || style(node).visibility !== "visible") continue;
      checkText(node, style(node).color, text.textContent!);
    }
    for (const node of timeline.querySelectorAll<HTMLElement>("*")) {
      for (const pseudo of ["::before", "::after"]) {
        const label = getComputedStyle(node, pseudo).content;
        if (/^"[^"]*\S[^"]*"$/.test(label) && node.getClientRects().length) checkText(node, getComputedStyle(node, pseudo).color, label.slice(1, -1));
      }
    }
  }
  problems.push(...textProblems.values());
  for (const state of ["tool:done", "tool:streaming", "tool:error", "tool:canceled", "approval:pending"]) {
    if (!seen.has(state)) problems.push(`no ${state.replace(":", " in state ")} on the page to check`);
  }
  return problems;
}

// Runs in the page: every control inside the parts against a fresh unstyled button's computed defaults.
function controlProblems(forced: string) {
  const reference = document.createElement("button");
  reference.textContent = "reference";
  document.body.append(reference);
  const base = getComputedStyle(reference);
  const defaults = { background: base.backgroundColor, border: `${base.borderTopStyle} ${base.borderTopWidth} ${base.borderTopColor}`, font: base.fontFamily };
  reference.remove();
  const problems: string[] = [];
  const controls = document.querySelectorAll<HTMLElement>('[data-part="timeline"] :is(button, summary, a[role="button"])');
  if (!controls.length) return ["no controls inside the parts to check"];
  for (const control of controls) {
    const style = getComputedStyle(control);
    const name = `${control.closest<HTMLElement>("[data-id]")?.dataset.id ?? "timeline"} ${control.tagName.toLowerCase()} "${control.textContent?.trim().slice(0, 30)}"${forced ? ` :${forced}` : ""}`;
    if (control.tagName === "SUMMARY") {
      if (style.display === "list-item") problems.push(`${name} keeps the default disclosure marker`);
      continue;
    }
    if (style.appearance !== "none") problems.push(`${name} has appearance ${style.appearance}`);
    if (style.backgroundColor === defaults.background) problems.push(`${name} has the default button background`);
    if (`${style.borderTopStyle} ${style.borderTopWidth} ${style.borderTopColor}` === defaults.border) problems.push(`${name} has the default button border`);
    if (style.fontFamily === defaults.font) problems.push(`${name} uses the default button font`);
  }
  return problems;
}

async function checkControls(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: '[data-part="timeline"] :is(button, summary, a[role="button"])' });
  const problems = await page.evaluate(controlProblems, "");
  for (const state of ["hover", "focus", "focus-visible", "active"]) {
    for (const nodeId of nodeIds) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [state] });
    problems.push(...await page.evaluate(controlProblems, state));
    for (const nodeId of nodeIds) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  }
  await cdp.detach();
  return problems;
}

type ViewerMeasurement = { fixture: string; width: number; openMs: number; appendMs: number; bottomGap: number; appendGap: number; middleMoved: boolean; outerMiddleDelta: number; outerBoundaryDelta: number; longTasks: number[]; tokens: number; scroll: { median: number; p95: number; over33: number } };

async function measureViewer(page: Page, width: number, fixture: "single" | "lines" | "read"): Promise<ViewerMeasurement> {
  await page.goto(`http://127.0.0.1:${port}/gallery.html?viewerFixture=${fixture}`);
  const button = page.getByRole("button", { name: /^open all/ });
  await button.waitFor();
  await page.waitForTimeout(500);
  // Long tasks from opening the viewer and highlighting its mounted rows, counted from the click.
  await page.evaluate(() => {
    const target = window as typeof window & { __longTasks: number[] };
    target.__longTasks = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) target.__longTasks.push(entry.duration); }).observe({ type: "longtask" });
  });
  const openMs = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => {
    const root = document.querySelector('[data-part="tool-body"]')!;
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-part="text-viewer"]')) return;
      observer.disconnect();
      resolve(performance.now() - started);
    });
    observer.observe(root, { childList: true, subtree: true });
    const started = performance.now();
    (document.querySelector('[data-action="open-viewer"]') as HTMLButtonElement).click();
  })));
  const viewer = page.locator('[data-part="text-viewer"]');
  await viewer.waitFor();
  await page.waitForTimeout(1_500);
  const longTasks = await page.evaluate(() => (window as typeof window & { __longTasks: number[] }).__longTasks);
  const tokens = await viewer.evaluate((node) => node.querySelectorAll("[class^=tok-]").length);
  // A log opens at its newest line; a file (read) opens at its first.
  const bottomGap = await viewer.evaluate((node, file) => (file ? node.scrollTop : node.scrollHeight - node.scrollTop - node.clientHeight), fixture === "read");
  await viewer.evaluate((node) => { node.scrollTop = node.scrollHeight / 2; });
  const middleBefore = await viewer.evaluate((node) => node.scrollTop);
  await viewer.hover();
  const outerMiddleBefore = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(50);
  const middleAfter = await viewer.evaluate((node) => node.scrollTop);
  const outerMiddleDelta = await page.evaluate((before) => scrollY - before, outerMiddleBefore);

  await viewer.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.evaluate(() => { document.body.style.paddingBottom = "2000px"; scrollBy(0, 100); });
  await viewer.hover();
  const outerBoundaryBefore = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(50);
  const outerBoundaryDelta = await page.evaluate((before) => scrollY - before, outerBoundaryBefore);

  await viewer.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(100);
  const appendMs = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => {
    const viewer = document.querySelector('[data-part="text-viewer"]')!;
    const observer = new MutationObserver(() => { observer.disconnect(); resolve(performance.now() - started); });
    observer.observe(viewer, { childList: true, subtree: true, characterData: true, attributes: true });
    const started = performance.now();
    (window as typeof window & { __appendViewerFixture: (delta: string) => void }).__appendViewerFixture("\nstreamed tail");
  })));
  await page.waitForTimeout(500);
  const appendGap = await viewer.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  // Frame times while the viewer scrolls 48 px a frame from the top, on a CPU four times slower.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const frames = await viewer.evaluate((node) => new Promise<number[]>((resolve) => {
    node.scrollTop = 0;
    const times: number[] = [];
    const step = (time: number) => {
      times.push(time);
      node.scrollTop += 48;
      if (times.length < 120) requestAnimationFrame(step);
      else resolve(times.slice(1).map((value, index) => value - times[index]!));
    };
    requestAnimationFrame(step);
  }));
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.detach();
  const sorted = [...frames].sort((a, b) => a - b);
  const scroll = { median: sorted[sorted.length >> 1]!, p95: sorted[Math.floor(sorted.length * 0.95)]!, over33: frames.filter((frame) => frame > 33.4).length };

  return { fixture, width, openMs, appendMs, bottomGap, appendGap, middleMoved: middleAfter > middleBefore, outerMiddleDelta, outerBoundaryDelta, longTasks, tokens, scroll };
}

// A large edit or search keeps its structure in the open viewer: language tokens, row kinds, and marks.
async function checkStructuredViewer(page: Page, fixture: "edit" | "search") {
  await page.goto(`http://127.0.0.1:${port}/gallery.html?viewerFixture=${fixture}`);
  const button = page.getByRole("button", { name: /^open all/ });
  await button.waitFor();
  await button.click();
  const viewer = page.locator('[data-part="text-viewer"]');
  await viewer.waitFor();
  await page.waitForTimeout(1_500);
  const selectors = fixture === "edit"
    ? { tokens: "[class^=tok-]", inserted: '[data-part="diff-line"][data-change="insert"]', deleted: '[data-part="diff-line"][data-change="delete"]', marks: 'mark[data-part="diff-word"]' }
    : { tokens: "[class^=tok-]", heads: '[data-part="search-head"]', lines: '[data-part="line"][data-match]', marks: 'mark[data-part="search-match"]' };
  const found = await viewer.evaluate((node, selectors) => Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, node.querySelectorAll(selector).length])), selectors);
  // Every fixture row is one short line: a taller row means a line-number column too narrow for 5-digit numbers.
  const wrapped = await viewer.evaluate((node) => [...node.querySelectorAll('[data-part="diff-line"], [data-part="line"]')].filter((row) => row.getBoundingClientRect().height > 30).length);
  return [
    ...Object.entries(found).filter(([, count]) => !count).map(([name]) => `viewer ${fixture}: no ${name} in the open viewer (${JSON.stringify(found)})`),
    ...(wrapped ? [`viewer ${fixture}: ${wrapped} rows wrap; line-number columns must fit the largest number`] : []),
  ];
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
  failures.push(...await checkWarmBodies(browser, port));
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

  // Real user intent right after a swap must win over the stale-scroll guard (review 3 blocker).
  const intent = await replay.evaluate(async () => {
    const scroll = document.querySelector<HTMLElement>(".scroll")!;
    const mode = document.querySelector<HTMLSelectElement>("#mode")!;
    mode.value = "static:100000";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (let i = 0; i < 600; i++) {
      await frame();
      const rows = document.querySelector('[data-virtual-id]')?.getAttribute("aria-setsize");
      if (rows === "100000" && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 1) break;
    }
    const swappedAt = performance.now();
    scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -2000, bubbles: true }));
    scroll.scrollTop -= 2000;
    scroll.dispatchEvent(new Event("scroll"));
    const elapsed = performance.now() - swappedAt;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { elapsed, scrollTop: scroll.scrollTop, maxScroll: scroll.scrollHeight - scroll.clientHeight };
  });
  if (intent.maxScroll - intent.scrollTop < 500 || pageErrors.length)
    failures.push(`user scroll right after swap was overridden: scrollTop=${intent.scrollTop}, maxScroll=${intent.maxScroll}, intent ${intent.elapsed.toFixed(1)} ms after the bottom write`);
  else console.log(`ok   user scroll right after swap kept: ${intent.maxScroll - intent.scrollTop} px above bottom, intent ${intent.elapsed.toFixed(1)} ms after the bottom write`);

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
      // Code highlighting arrives after the highlighter loads; without this wait the text audit sees almost no syntax
      // spans. Wait for the five main roles, then for the span count to hold still.
      const missingRoles = () => page.evaluate(() => ["keyword", "string", "comment", "function", "type"].filter((role) => !document.querySelector(`[data-part="timeline"] .tok-${role}`)));
      const highlighted = await page.waitForFunction(() => ["keyword", "string", "comment", "function", "type"].every((role) => document.querySelector(`[data-part="timeline"] .tok-${role}`)), undefined, { timeout: 30_000 }).then(() => true, () => false);
      if (!highlighted) failures.push(`${theme} @ ${width}: no .tok-${(await missingRoles()).join(", .tok-")} span after 30 s; syntax highlighting did not arrive`);
      for (let last = -1, i = 0; i < 40; i++) {
        const spans = await page.locator('[data-part="timeline"] [class*="tok-"]').count();
        if (spans === last) break;
        last = spans;
        await page.waitForTimeout(250);
      }
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
      // Control styling does not depend on the palette: one light and one dark theme at each width.
      if (theme === "github-light" || theme === "gruvbox-dark") for (const problem of await checkControls(page)) failures.push(`${theme} @ ${width}: ${problem}`);
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
  for (const width of [390, 1440]) {
    for (const fixture of ["single", "lines", "read"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const measured = await measureViewer(page, width, fixture);
      console.log(`viewer ${fixture} @ ${width}: open ${measured.openMs.toFixed(1)} ms, append ${measured.appendMs.toFixed(1)} ms, gaps ${measured.bottomGap.toFixed(1)}/${measured.appendGap.toFixed(1)} px, long tasks [${measured.longTasks.map((ms) => ms.toFixed(0)).join(", ")}], ${measured.tokens} token spans, 4x-throttled scroll frames median ${measured.scroll.median.toFixed(1)} ms / p95 ${measured.scroll.p95.toFixed(1)} ms / ${measured.scroll.over33} over 33 ms`);
      if (fixture === "read" && measured.longTasks.length) failures.push(`viewer read @ ${width}: long tasks while opening and highlighting [${measured.longTasks.map((ms) => ms.toFixed(0)).join(", ")}] ms`);
      if (fixture === "read" && !measured.tokens) failures.push(`viewer read @ ${width}: the mounted rows of a .ts file were not highlighted`);
      if (measured.openMs >= 16) failures.push(`viewer ${fixture} @ ${width}: open took ${measured.openMs.toFixed(1)} ms, needs <16 ms`);
      if (measured.appendMs >= 16) failures.push(`viewer ${fixture} @ ${width}: append took ${measured.appendMs.toFixed(1)} ms, needs <16 ms`);
      if (Math.abs(measured.bottomGap) > 1) failures.push(`viewer ${fixture} @ ${width}: initial ${fixture === "read" ? "top" : "bottom"} gap ${measured.bottomGap.toFixed(1)} px, needs <=1 px`);
      if (Math.abs(measured.appendGap) > 1 && fixture !== "read") failures.push(`viewer ${fixture} @ ${width}: append bottom gap ${measured.appendGap.toFixed(1)} px, needs <=1 px`);
      if (!measured.middleMoved || measured.outerMiddleDelta !== 0) failures.push(`viewer ${fixture} @ ${width}: middle wheel did not stay inside viewer`);
      if (measured.outerBoundaryDelta !== 0) failures.push(`viewer ${fixture} @ ${width}: boundary wheel moved outer page ${measured.outerBoundaryDelta}px`);
      await page.close();
    }
  }
  for (const fixture of ["edit", "search"] as const) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const problems = await checkStructuredViewer(page, fixture);
    failures.push(...problems);
    if (!problems.length) console.log(`ok   viewer ${fixture}: tokens, row kinds, and marks`);
    await page.close();
  }
} finally {
  await browser?.close();
  preview.kill("SIGTERM");
  await once(preview, "exit").catch(() => {});
}
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
