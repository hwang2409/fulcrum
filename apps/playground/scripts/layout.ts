// Fails when the gallery or another playground page scrolls sideways at any common width (the gallery in every theme), when a
// playground page control has no accessible name or is under 44 px tall at touch widths (36 px elsewhere), when a pending approval's actions are hard
// to read or to hit (text contrast below 4.5:1 on the real background, or under 44 px tall at touch widths, 36 px
// elsewhere), when a theme's fg or muted text misses 4.5:1 on its bg, or when a state indicator is hard to see: every
// rendered status word needs 4.5:1 and every state mark and state rail 3:1 against the background it is drawn on, and
// ok, warn, danger, and accent (running) need 3:1 on bg, when a capped output box cuts through a line, or when
// the keyword, string, comment, function, and type token colors are not all distinct. Every visible text inside the
// parts (labels drawn by ::before/::after too), syntax tokens included, must reach 4.5:1 on the background it is drawn on,
// in every theme; only text inside an ANSI color span, or on an ANSI background, must reach 3:1, the floor for official
// terminal colors (packages/react/themes.css). Tool facts (paths, numbers, counts) are UI text at 4.5:1. Every button, summary, and
// a[role=button] inside the parts must be a styled fulcrum control, with no browser-default appearance, ButtonFace
// background, default border, or system font, at rest and under forced :hover, :focus, :focus-visible, and :active. The large-output viewer's median open and append operations stay under 16 ms, it follows the bottom, and highlights a
// 1,000,000-line file with no long tasks; scrolling it under 4x CPU throttling is reported. Needs a production build
// (`bun run build`). Collapsed tool bodies warm before they open (see warm-check.ts). Every highlighted box is
// colored line by line against its fixture (see token-check.ts). The ux test 6 regressions are in ux-check.ts.
//
// VIEWER TIMING DETECTION CONTRACT:
// (a) zero false positives: A/A stays at least 0.15 below every threshold, normally and under load;
// (b) any viewer slowdown of 1.5x or more fails 5/5 through paired wall and task ratios;
// (c) O(n)-per-append viewer work fails 5/5 when its cost at 128k lines is at least 55 ms per append (about
// 370% of the correct append cost), measured as head-only append task-time scaling between 16k and 128k lines.
// (d) a slowdown shared by head and base fails the calibrated ceiling: candidate median / same-run fixed-DOM work, per
// width and operation (budgets and samples in viewer-verdict.ts).
// The scaling probe runs several appends under 4x CPU throttling. Array.push and pushed `text-*` segment counts are
// cheap extra canaries for rebuilding segments or visiting every row; task-time scaling is the proof.
import { chromium, type Locator, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { checkComposer } from "./composer-check.js";
import { checkStreams } from "./stream-check.js";
import { checkCards } from "./cards-check.js";
import { checkUx } from "./ux-check.js";
import { checkSubAgents } from "./subagent-check.js";
import { checkWarmBodies } from "./warm-check.js";
import { checkLineTokens } from "./token-check.js";
import { median, ratio, recordUnthrottledViewerFailures, recordViewerScalingFailures, recordViewerTimingFailures, viewerRatioBudget, type Calibration, type ScalingCheck, type ScalingPair, type ViewerCheck, type ViewerSample, type ViewerTiming } from "./viewer-verdict.js";

const widths = [390, 768, 1024, 1440];
const touchWidth = 860; // the gallery's touch breakpoint
const port = Number(process.env.LAYOUT_PORT ?? 4174); // override when another checkout already serves 4174
const baseRoot = process.env.LAYOUT_BASE_ROOT;
const basePort = Number(process.env.LAYOUT_BASE_PORT ?? port + 1);
const candidateUrl = `http://127.0.0.1:${port}`;
const baseUrl = baseRoot ? `http://127.0.0.1:${basePort}` : undefined;
const previews: ChildProcess[] = [];
function startPreview(root: string, serverPort: number) {
  const child = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(serverPort), "--strictPort"], { cwd: root, stdio: "ignore" });
  previews.push(child);
  return child;
}
const preview = startPreview(new URL("..", import.meta.url).pathname, port);
const basePreview = baseRoot ? startPreview(baseRoot, basePort) : undefined;
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
  // One pending approval card: its action row shape, metrics, labels, contrast, hit size, and opacity.
  const approvalProblems = (card: HTMLElement) => {
    const found: string[] = [];
    const buttons = [...card.querySelectorAll<HTMLButtonElement>("[data-part=approval-actions] button")];
    const actions = buttons.map((button) => button.dataset.action).join(" ");
    if (actions !== "approve deny" && actions !== "approve approve-always deny") found.push(`${card.dataset.id}: actions "${actions}", expected approve, optional approve-always, and deny`);
    // The actions share one row at every width: a wrapped action reads as a separate, unrelated control.
    if (new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size > 1) found.push(`${card.dataset.id}: approval actions wrap onto two rows`);
    // The actions share the row's height: a wrapped long label must not leave its neighbours shorter.
    const heights = buttons.map((button) => Math.round(button.getBoundingClientRect().height));
    if (new Set(heights).size > 1) found.push(`${card.dataset.id}: approval action heights differ (${heights.join(", ")} px)`);
    // The plain two-action row keeps its one-line metrics: a 13 px label on a 13 px line, at exactly the minimum hit height.
    if (actions === "approve deny")
      for (const button of buttons) {
        const { fontSize, lineHeight } = getComputedStyle(button);
        if (lineHeight !== fontSize || Math.round(button.getBoundingClientRect().height) !== minHeight)
          found.push(`${card.dataset.id} ${button.dataset.action}: two-action metrics changed (line-height ${lineHeight} for a ${fontSize} font, ${Math.round(button.getBoundingClientRect().height)} px tall, expected ${minHeight} px)`);
      }
    for (const button of buttons) {
      const name = `${card.dataset.id} ${button.textContent?.trim() || "(unnamed button)"}`;
      let opacity = 1;
      for (let node: HTMLElement | null = button; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      const contrast = contrastOn(getComputedStyle(button).color, backgroundOf(button));
      const height = button.getBoundingClientRect().height;
      if (button.textContent?.trim() === "") found.push(`${name} has no visible label`);
      if (contrast < 4.5) found.push(`${name} text contrast ${contrast.toFixed(2)}:1, needs 4.5:1`);
      if (height < minHeight) found.push(`${name} is ${Math.round(height)} px tall, needs ${minHeight} px`);
      if (opacity < 1) found.push(`${name} is faded to opacity ${opacity.toFixed(2)}`);
    }
    return found;
  };
  const problems: string[] = [];
  const cards = [...document.querySelectorAll<HTMLElement>("[data-part=approval][data-state=pending]")];
  if (!cards.length) return ["no pending approval on the page"];
  for (const card of cards) problems.push(...approvalProblems(card));
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
  // Every visible text in the parts, and the text labels drawn by ::before and ::after, at 4.5:1 on what is behind it.
  // Only terminal output gets 3:1, by class, never by color: text inside an ANSI color span, or bg-colored text on an
  // ANSI background (.ansi-has-bg). Syntax tokens, tool facts, and every other UI text stay at 4.5:1.
  const ansiColors = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap((name) => [name, `bright-${name}`]);
  const terminal = [...ansiColors.flatMap((name) => [`.ansi-${name}`, `.ansi-text-${name}`]), ".ansi-has-bg"].join(", ");
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
    const min = node.closest(terminal) ? 3 : 4.5;
    if (ratio >= min) return;
    const where = node.closest<HTMLElement>("[data-part]");
    const key = `${where?.dataset.part}.${node.className || node.tagName.toLowerCase()} ${color}`;
    if (!textProblems.has(key)) textProblems.set(key, `text "${sample.trim().slice(0, 24)}" (${key}) is ${ratio.toFixed(2)}:1, needs ${min}:1`);
  };
  for (const timeline of document.querySelectorAll<HTMLElement>('[data-part="timeline"], [data-part="run-bar"], [data-part="composer"]')) {
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
  const controls = document.querySelectorAll<HTMLElement>(':is([data-part="timeline"], [data-part="run-bar"], [data-part="composer"]) :is(button, summary, a[role="button"])');
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
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ':is([data-part="timeline"], [data-part="run-bar"], [data-part="composer"]) :is(button, summary, a[role="button"])' });
  const problems = await page.evaluate(controlProblems, "");
  for (const state of ["hover", "focus", "focus-visible", "active"]) {
    for (const nodeId of nodeIds) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [state] });
    problems.push(...await page.evaluate(controlProblems, state));
    for (const nodeId of nodeIds) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  }
  await cdp.detach();
  return problems;
}

type ViewerMeasurement = ViewerTiming & { fixture: string; width: number; calibration: Calibration; bottomGap: number; appendGap: number; middleMoved: boolean; outerMiddleDelta: number; outerBoundaryDelta: number; longTasks: number[]; tokens: number; scroll: { median: number; p95: number; over33: number } };
type ViewerPair = { base: ViewerSample; candidate: ViewerSample };

const viewerSamples = 5;
const viewerScalingPairs = 11;
const scalingDelta = `\n${"x".repeat(65_535)}`; // one long line per append: a rebuilt segment shows in the canaries
const ratios = (pairs: ViewerPair[], field: keyof ViewerSample) => pairs.map((pair) => ratio(pair.candidate[field], pair.base[field]));
// Five alternating base/head pairs use their median ratio, not a ratio of independent medians. The 1.4x A/B ceiling
// leaves the required margin over observed A/A noise. Scaling compares the same append at 16k and 128k lines; correct
// virtualized work stays O(visible). A local run without a base is judged by the calibrated ceiling alone.

async function measureViewer(page: Page, width: number, fixture: "single" | "lines" | "read"): Promise<ViewerMeasurement> {
  const openSamples: number[] = [];
  for (let sample = 0; sample < viewerSamples; sample++) {
    await page.goto(`${candidateUrl}/gallery.html?viewerFixture=${fixture}`);
    openSamples.push(await openViewer(page, fixture === "read" ? Number(process.env.TIMING_GATE_SLOWDOWN_MS ?? 0) : 0, sample === viewerSamples - 1));
  }
  const openMs = median(openSamples);
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
  const appended = await appendViewer(page, fixture === "read" ? Number(process.env.TIMING_GATE_SLOWDOWN_MS ?? 0) : 0, 0);
  const { appendMs, samples: appendSamples } = appended;
  await page.waitForTimeout(500);
  const appendGap = await viewer.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  const scroll = await measureViewerScroll(page, viewer);
  const calibration = await measureCalibrationSet(page, measureCalibration); // this page measures unthrottled

  return { fixture, width, openMs, appendMs, openSamples, appendSamples, calibration, bottomGap, appendGap, middleMoved: middleAfter > middleBefore, outerMiddleDelta, outerBoundaryDelta, longTasks, tokens, scroll };
}

async function measureViewerScroll(page: Page, viewer: Locator) {
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
  const sorted = [...frames].sort((left, right) => left - right);
  return { median: sorted[sorted.length >> 1]!, p95: sorted[Math.floor(sorted.length * 0.95)]!, over33: frames.filter((frame) => frame > 33.4).length };
}

async function prepareViewerOpen(page: Page, observeLongTasks = false) {
  await page.getByRole("button", { name: /^open all/ }).waitFor();
  await page.waitForTimeout(500);
  if (observeLongTasks) await page.evaluate(() => {
    const target = window as typeof window & { __longTasks: number[] };
    target.__longTasks = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) target.__longTasks.push(entry.duration); }).observe({ type: "longtask" });
  });
}

const clickViewer = (page: Page, slowdown = 0) => page.evaluate((delay) => new Promise<number>((resolve) => requestAnimationFrame(() => {
  const root = document.querySelector('[data-part="tool-body"]')!;
  const observer = new MutationObserver(() => {
    if (!document.querySelector('[data-part="text-viewer"]')) return;
    observer.disconnect();
    resolve(performance.now() - started);
  });
  observer.observe(root, { childList: true, subtree: true });
  const started = performance.now();
  if (delay) { const until = performance.now() + delay; while (performance.now() < until) { /* deliberate proof slowdown */ } }
  (document.querySelector('[data-action="open-viewer"]') as HTMLButtonElement).click();
})), slowdown);

async function openViewer(page: Page, slowdown = 0, observeLongTasks = false) {
  await prepareViewerOpen(page, observeLongTasks);
  return clickViewer(page, slowdown);
}

async function appendViewer(page: Page, slowdown: number, offset: number, count = viewerSamples, delta?: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const measured: { wall: number; task: number; pushes: number; segmentPushes: number }[] = [];
  for (let sample = 0; sample < count; sample++) {
    const before = (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0;
    const result = await page.evaluate(({ delay, index, tail }) => new Promise<{ wall: number; pushes: number; segmentPushes: number }>((resolve) => requestAnimationFrame(() => {
    const target = window as typeof window & { __appendViewerFixture: (delta: string) => void };
    const root = document.querySelector('[data-part="tool-body"]')!;
    const originalPush = Array.prototype.push;
    let pushes = 0;
    let segmentPushes = 0;
    Array.prototype.push = function (...values) {
      pushes += values.length;
      segmentPushes += values.filter((value) => typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && value.id.startsWith("text-") && "start" in value).length;
      return Reflect.apply(originalPush, this, values);
    };
    const observer = new MutationObserver(() => {
      observer.disconnect();
      Array.prototype.push = originalPush;
      resolve({ wall: performance.now() - started, pushes, segmentPushes });
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    const started = performance.now();
    if (delay) { const until = performance.now() + delay; while (performance.now() < until) { /* deliberate proof slowdown */ } }
    target.__appendViewerFixture(tail ?? `\npaired tail ${index}`);
  })), { delay: slowdown, index: offset + sample, tail: delta });
    const after = (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "TaskDuration")?.value ?? before;
    measured.push({ ...result, task: (after - before) * 1_000 });
  }
  await cdp.detach();
  const samples = measured.map(({ wall }) => wall);
  const taskSamples = measured.map(({ task }) => task);
  return { appendMs: median(samples), appendTaskMs: median(taskSamples), appendPushes: median(measured.map(({ pushes }) => pushes)), segmentPushes: median(measured.map(({ segmentPushes }) => segmentPushes)), samples, taskSamples };
}

async function measureViewerSample(page: Page, url: string, slowdown: number, sample: number, lines?: number, delta?: string) {
  const query = new URLSearchParams({ viewerFixture: "read" });
  if (lines) query.set("viewerLines", String(lines));
  await page.goto(`${url}/gallery.html?${query}`);
  await prepareViewerOpen(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const before = (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0;
  const openMs = await clickViewer(page, slowdown);
  const after = (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "TaskDuration")?.value ?? before;
  const openTaskMs = (after - before) * 1_000;
  const viewer = page.locator('[data-part="text-viewer"]');
  await viewer.waitFor();
  await viewer.locator("[class^=tok-]").first().waitFor();
  await viewer.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(100); // keep asynchronous range coloring outside the scoped append task
  const appended = await appendViewer(page, slowdown, sample * viewerSamples, viewerSamples, delta);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.detach();
  return { openMs, openTaskMs, ...appended };
}

async function measureViewerTiming(page: Page, url: string, slowdown = 0): Promise<ViewerTiming> {
  const openSamples: number[] = [];
  const appendSamples: number[] = [];
  for (let sample = 0; sample < viewerSamples; sample++) {
    const measured = await measureViewerSample(page, url, slowdown, sample);
    openSamples.push(measured.openMs);
    appendSamples.push(measured.appendMs);
  }
  return { openMs: median(openSamples), appendMs: median(appendSamples), openSamples, appendSamples };
}

async function measureCalibration(page: Page) {
  return page.evaluate(() => {
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;top:0;left:0;width:1024px;height:900px;overflow:auto;visibility:hidden;font:13px monospace"; // fixed width: the same line boxes at every viewport
    const started = performance.now();
    for (let i = 0; i < 1_000; i++) {
      const row = document.createElement("div");
      row.textContent = `${i}: ${"fixed calibration text ".repeat(4)}`;
      root.append(row);
    }
    document.body.append(root);
    void root.scrollHeight;
    const elapsed = performance.now() - started;
    root.remove();
    return elapsed;
  });
}

async function measureThrottledCalibration(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    return await measureCalibration(page);
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
}

async function measureCalibrationSet(page: Page, measure = measureThrottledCalibration): Promise<Calibration> {
  const samples: number[] = [];
  for (let sample = 0; sample < viewerSamples; sample++) samples.push(await measure(page));
  return { median: median(samples), samples };
}

async function checkViewerTiming(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number): Promise<ViewerCheck> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const slowdown = Number(process.env.TIMING_GATE_SLOWDOWN_MS ?? 0);
  try {
    if (!baseUrl) {
      await page.goto(`${candidateUrl}/gallery.html?viewerFixture=read`);
      await prepareViewerOpen(page);
      const calibration = await measureCalibrationSet(page);
      const candidate = await measureViewerTiming(page, candidateUrl, slowdown);
      console.log(`viewer calibration @ ${width}: ${calibration.median.toFixed(1)} ms [${calibration.samples.map((value) => value.toFixed(1)).join(", ")}], open/calibration ${ratio(candidate.openMs, calibration.median).toFixed(2)}x, append/calibration ${ratio(candidate.appendMs, calibration.median).toFixed(2)}x`);
      return { candidate, calibration };
    }
    const pairs: ViewerPair[] = [];
    const calibrationSamples: number[] = [];
    const calibrate = async () => {
      await page.goto(`${candidateUrl}/gallery.html?viewerFixture=read`);
      await prepareViewerOpen(page); // let page load finish so it does not compete with the fixed work
      calibrationSamples.push(await measureThrottledCalibration(page));
    };
    for (let pair = 0; pair < viewerSamples; pair++) {
      if (pair % 2 === 0) await calibrate();
      const firstUrl = pair % 2 ? candidateUrl : baseUrl;
      const secondUrl = pair % 2 ? baseUrl : candidateUrl;
      const first = await measureViewerSample(page, firstUrl, firstUrl === candidateUrl ? slowdown : 0, pair);
      const second = await measureViewerSample(page, secondUrl, secondUrl === candidateUrl ? slowdown : 0, pair);
      pairs.push(pair % 2 ? { candidate: first, base: second } : { base: first, candidate: second });
      if (pair % 2 === 1) await calibrate();
    }
    const calibration = { median: median(calibrationSamples), samples: calibrationSamples };
    const candidate = { openMs: median(pairs.map(({ candidate }) => candidate.openMs)), openTaskMs: median(pairs.map(({ candidate }) => candidate.openTaskMs)), appendMs: median(pairs.map(({ candidate }) => candidate.appendMs)), appendTaskMs: median(pairs.map(({ candidate }) => candidate.appendTaskMs)) };
    const baseline = { openMs: median(pairs.map(({ base }) => base.openMs)), openTaskMs: median(pairs.map(({ base }) => base.openTaskMs)), appendMs: median(pairs.map(({ base }) => base.appendMs)), appendTaskMs: median(pairs.map(({ base }) => base.appendTaskMs)) };
    const distributions = { openMs: ratios(pairs, "openMs"), openTaskMs: ratios(pairs, "openTaskMs"), appendMs: ratios(pairs, "appendMs"), appendTaskMs: ratios(pairs, "appendTaskMs") };
    const pairedRatios = { openMs: median(distributions.openMs), openTaskMs: median(distributions.openTaskMs), appendMs: median(distributions.appendMs), appendTaskMs: median(distributions.appendTaskMs) };
    const show = (values: number[]) => values.map((value) => value.toFixed(2)).join(", ");
    const calibrationLog = `${calibration.median.toFixed(1)} ms [${calibration.samples.map((value) => value.toFixed(1)).join(", ")}]`;
    console.log(`viewer A/B @ ${width}: open candidate ${candidate.openMs.toFixed(1)} ms, base ${baseline.openMs.toFixed(1)} ms, calibration ${calibrationLog}, paired ${pairedRatios.openMs.toFixed(2)}x, normalized ${ratio(candidate.openMs, calibration.median).toFixed(2)}x; open task candidate ${candidate.openTaskMs.toFixed(1)} ms, base ${baseline.openTaskMs.toFixed(1)} ms, paired ${pairedRatios.openTaskMs.toFixed(2)}x; append candidate ${candidate.appendMs.toFixed(1)} ms, base ${baseline.appendMs.toFixed(1)} ms, calibration ${calibrationLog}, paired ${pairedRatios.appendMs.toFixed(2)}x, normalized ${ratio(candidate.appendMs, calibration.median).toFixed(2)}x; append task candidate ${candidate.appendTaskMs.toFixed(1)} ms, base ${baseline.appendTaskMs.toFixed(1)} ms, paired ${pairedRatios.appendTaskMs.toFixed(2)}x`);
    console.log(`viewer A/B distributions @ ${width}: open wall [${show(distributions.openMs)}]; open task [${show(distributions.openTaskMs)}]; append wall [${show(distributions.appendMs)}]; append task [${show(distributions.appendTaskMs)}]`);
    return { candidate, calibration, pairedRatios };
  } finally { await page.close(); }
}

async function checkViewerScaling(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<ScalingCheck> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    const pairs: ScalingPair[] = [];
    for (let pair = 0; pair < viewerScalingPairs; pair++) {
      // Each pair measures 16k and 128k back to back, in alternating order, so runner drift cancels inside the pair.
      const first = await measureViewerSample(page, candidateUrl, 0, pair, pair % 2 ? 128_000 : 16_000, scalingDelta);
      const second = await measureViewerSample(page, candidateUrl, 0, pair, pair % 2 ? 16_000 : 128_000, scalingDelta);
      pairs.push(pair % 2 ? { small: second, large: first } : { small: first, large: second });
    }
    await page.goto(`${candidateUrl}/gallery.html?viewerFixture=read&viewerLines=1000000`);
    await openViewer(page);
    return { pairs, mountedRows: await page.locator('[data-part="text-viewer-row"]').count() };
  } finally { await page.close(); }
}

function recordViewerScaling(check: ScalingCheck, failures: string[]) {
  const summary = recordViewerScalingFailures(check, failures);
  const show = (side: "small" | "large") => check.pairs.map((pair) => pair[side].appendTaskMs.toFixed(2)).join(", ");
  console.log(`viewer append scaling: paired 128k/16k task ratio ${summary.taskRatio.toFixed(3)}x [${summary.taskRatios.map((value) => value.toFixed(3)).join(", ")}], task 16k [${show("small")}] ms, 128k [${show("large")}] ms; canary segment-push ratio ${summary.segmentPushRatio.toFixed(3)}x, all-push ratio ${summary.pushRatio.toFixed(3)}x; 1m mounted rows ${check.mountedRows}`);
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
  const pairedProof = [ratio(6, 4), ratio(12, 8), ratio(18, 12), ratio(24, 16), ratio(30, 20)];
  if (median(pairedProof) <= viewerRatioBudget || median([1.1, 1.15, 1.2, 1.25, 1.3]) > viewerRatioBudget)
    throw new Error("viewer timing regression sensitivity self-check failed");
  console.log("ok   viewer timing sensitivity: paired ratios reject a 1.5x regression without rejecting A/A noise");
  const servers = [[candidateUrl, preview], ...(baseUrl && basePreview ? [[baseUrl, basePreview] as const] : [])] as const;
  for (const [url, child] of servers) {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${url}/gallery.html`)).ok) break; } catch {}
      if (child.exitCode !== null || i === 100) throw new Error(`vite preview did not start: ${url}`);
      await Bun.sleep(100);
    }
  }
  browser = await chromium.launch();
  if (process.env.VIEWER_TIMING_ONLY) {
    for (const width of [390, 1440]) recordViewerTimingFailures(await checkViewerTiming(browser, width), width, failures);
    recordViewerScaling(await checkViewerScaling(browser), failures);
    await browser.close();
    browser = undefined;
    for (const child of previews) child.kill("SIGTERM");
    await Promise.all(previews.map((child) => once(child, "exit").catch(() => {})));
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(failures.length ? 1 : 0);
  }
  failures.push(...await checkWarmBodies(browser, port));
  failures.push(...await checkSubAgents(browser, port));
  failures.push(...await checkComposer(browser, port));
  failures.push(...await checkStreams(browser, port));
  failures.push(...await checkCards(browser, port));
  failures.push(...await checkUx(browser, port));
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
    const scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
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
    const scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
    return { scrollTop: scroll.scrollTop, maxScroll: scroll.scrollHeight - scroll.clientHeight };
  });
  if (Math.abs(swap.scrollTop - swap.maxScroll) > 1 || pageErrors.length)
    failures.push(`active-scroll store swap: scrollTop=${swap.scrollTop}, maxScroll=${swap.maxScroll}, errors=${pageErrors.join("; ") || "none"}`);
  else console.log(`ok   active-scroll store swap: scrollTop ${swap.scrollTop}, maxScroll ${swap.maxScroll}`);

  // Real user intent right after a swap must win over the stale-scroll guard (review 3 blocker).
  const intent = await replay.evaluate(async () => {
    const mode = document.querySelector<HTMLSelectElement>("#mode")!;
    mode.value = "static:100000";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let scroll: HTMLElement;
    for (let i = 0; ; i++) {
      await frame();
      scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
      const rows = document.querySelector('[data-virtual-id]')?.getAttribute("aria-setsize");
      if (rows === "100000" && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 1) break;
      if (i === 599) throw new Error("the 100,000-row swap did not settle");
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
      // spans. Wait for the first keyword span, then for the span count to hold still for 1 s.
      const highlighted = await page.waitForSelector('[data-part="timeline"] .tok-keyword', { timeout: 30_000 }).then(() => true, () => false);
      if (!highlighted) failures.push(`${theme} @ ${width}: no .tok-keyword span after 30 s; syntax highlighting did not arrive`);
      for (let last = -1, still = 0, i = 0; still < 4 && i < 80; i++) {
        const spans = await page.locator('[data-part="timeline"] [class*="tok-"]').count();
        still = spans === last ? still + 1 : 0;
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
      // Each load starts a cold highlighter, so this also checks a grammar's first lines.
      const plain = await checkLineTokens(page);
      for (const problem of plain) failures.push(`${theme} @ ${width}: ${problem}`);
      if (!plain.length) console.log(`ok   ${theme} @ ${width}: every highlighted box matches its line fixture`);
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
      console.log(`viewer ${fixture} @ ${width}: open ${measured.openMs.toFixed(1)} ms [${measured.openSamples.map((value) => value.toFixed(1)).join(", ")}], append ${measured.appendMs.toFixed(1)} ms [${measured.appendSamples.map((value) => value.toFixed(1)).join(", ")}], calibration ${measured.calibration.median.toFixed(1)} ms [${measured.calibration.samples.map((value) => value.toFixed(1)).join(", ")}], normalized ${ratio(measured.openMs, measured.calibration.median).toFixed(2)}x/${ratio(measured.appendMs, measured.calibration.median).toFixed(2)}x, gaps ${measured.bottomGap.toFixed(1)}/${measured.appendGap.toFixed(1)} px, long tasks [${measured.longTasks.map((ms) => ms.toFixed(0)).join(", ")}], ${measured.tokens} token spans, 4x-throttled scroll frames median ${measured.scroll.median.toFixed(1)} ms / p95 ${measured.scroll.p95.toFixed(1)} ms / ${measured.scroll.over33} over 33 ms`);
      if (fixture === "read" && measured.longTasks.length) failures.push(`viewer read @ ${width}: long tasks while opening and highlighting [${measured.longTasks.map((ms) => ms.toFixed(0)).join(", ")}] ms`);
      if (fixture === "read" && !measured.tokens) failures.push(`viewer read @ ${width}: the mounted rows of a .ts file were not highlighted`);
      recordUnthrottledViewerFailures(measured, failures);
      if (Math.abs(measured.bottomGap) > 1) failures.push(`viewer ${fixture} @ ${width}: initial ${fixture === "read" ? "top" : "bottom"} gap ${measured.bottomGap.toFixed(1)} px, needs <=1 px`);
      if (Math.abs(measured.appendGap) > 1 && fixture !== "read") failures.push(`viewer ${fixture} @ ${width}: append bottom gap ${measured.appendGap.toFixed(1)} px, needs <=1 px`);
      if (!measured.middleMoved || measured.outerMiddleDelta !== 0) failures.push(`viewer ${fixture} @ ${width}: middle wheel did not stay inside viewer`);
      if (measured.outerBoundaryDelta !== 0) failures.push(`viewer ${fixture} @ ${width}: boundary wheel moved outer page ${measured.outerBoundaryDelta}px`);
      await page.close();
    }
  }
  for (const width of [390, 1440]) recordViewerTimingFailures(await checkViewerTiming(browser, width), width, failures);
  recordViewerScaling(await checkViewerScaling(browser), failures);
  for (const fixture of ["edit", "search"] as const) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const problems = await checkStructuredViewer(page, fixture);
    failures.push(...problems);
    if (!problems.length) console.log(`ok   viewer ${fixture}: tokens, row kinds, and marks`);
    await page.close();
  }
} finally {
  await browser?.close();
  for (const child of previews) child.kill("SIGTERM");
  await Promise.all(previews.map((child) => once(child, "exit").catch(() => {})));
}
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
