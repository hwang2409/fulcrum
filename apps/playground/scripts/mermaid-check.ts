// Mermaid fences in real chromium (vite's dev server with production react). Fails when:
// - the diagram swap moves the reading position by more than 1 px in any painted frame (the gap to the bottom while
//   the virtual timeline follows; the first row in view otherwise), with the diagram at the bottom, just above the
//   viewport, or below it, in virtual and plain timelines; when the box passes through any height between its source
//   and its diagram (a blank or collapsed frame); or when the svg is inserted more than once;
// - a reader's move up (a scrollbar drag, wheel, key, or touch) in the same frame as the last row's growth does not
//   hold in every painted frame, or, with no move, the end leaves the view in any painted frame;
// - a remounted diagram does not show from the cache in its first commit;
// - with 50 diagrams, any diagram far from the view draws before it is scrolled near, or they do not all draw;
// - hostile diagrams (html labels, click callbacks, javascript: links, outside urls, init/frontmatter overrides) get
//   html, script, a link, or an outside url into the page, or sanitizeSvg keeps one;
// - the page fetches mermaid before the first fence closes;
// - a gallery diagram at 1440, 768, or 390 px is scaled up, scaled so its smallest label is under 11 px, scrolls when
//   it could shrink and stay readable, or overflows its box without an edge fade and a labelled focusable region;
// - at 390 px the diagram does not scroll inside its box, or the page scrolls sideways;
// - the bar's controls are not reachable by Tab with their names, full size does not open and close by keyboard with
//   focus back on its button, or the svg has no label;
// - a theme switch does not redraw the diagram in the new theme's accent.
// Prints first-draw, warm-draw, and cached times. Writes and removes apps/playground/.mermaid-check.html.
import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";

const app = new URL("../", import.meta.url);
const fixture = new URL(".mermaid-check.html", app);
const port = Number(process.env.MERMAID_CHECK_PORT ?? 4177);
await writeFile(fixture, '<!doctype html><html data-fulcrum-theme="github-light"><body><div id="root"></div><script type="module" src="/scripts/mermaid-check-page.ts"></script></body></html>\n');
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: app.pathname, stdio: "ignore", env: { ...process.env, NODE_ENV: "production" } });
const failures: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
type Scenarios = Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;
// Each scenario gets 3 minutes: a hang is a failure with its name, not a stuck job.
const run = (page: Page, name: string, ...args: unknown[]) => {
  console.error(`running ${name} ${args.join(" ")}`);
  return Promise.race([
    page.evaluate(([name, args]) => (window as unknown as { scenarios: Scenarios }).scenarios[name as string]!(...(args as unknown[])), [name, args] as const),
    Bun.sleep(180_000).then(() => { throw new Error(`${name} ${args.join(" ")} did not finish in 3 minutes`); }),
  ]);
};

try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/.mermaid-check.html`)).ok) break; } catch {}
    if (vite.exitCode !== null || attempt === 300) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${port}` });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") console.error(`page: ${message.text()}`); });
  const mermaidRequests: string[] = [];
  page.on("request", (request) => { if (/packages\/mermaid\/dist\/(render|chunks\/)/.test(request.url())) mermaidRequests.push(request.url()); });
  await page.goto(`http://127.0.0.1:${port}/.mermaid-check.html`);
  await page.waitForFunction(() => "scenarios" in window, undefined, { timeout: 120_000 });
  if (mermaidRequests.length) failures.push(`mermaid loaded before any diagram: ${mermaidRequests[0]}`);

  const swaps = [];
  for (const virtual of [true, false]) for (const where of ["bottom", "above", "below"] as const) swaps.push(await run(page, "swap", virtual, where));
  if (!mermaidRequests.length) failures.push("no request for mermaid's render module after the first diagram");
  for (const result of swaps) {
    const name = `swap ${result.virtual ? "virtual" : "plain"} ${result.where}`;
    console.log(`${name}\t${JSON.stringify(result)}`);
    if ((result.drift as number) > 1) failures.push(`${name}: the reading position moved ${result.drift} px`);
    if ((result.heights as number[]).length > 2) failures.push(`${name}: the box went through ${(result.heights as number[]).join(" -> ")} px, expected source -> diagram`);
    if (result.inserts !== 1) failures.push(`${name}: the svg was inserted ${result.inserts} times`);
  }
  for (const input of ["none", "scrollbar", "wheel", "key", "touch"]) {
    const result = await run(page, "race", input);
    console.log(`race ${input}\t${JSON.stringify(result)}`);
    if ((result.grew as number) < 300) failures.push(`race ${input}: the row grew only ${result.grew} px`);
    if (result.wrong) failures.push(input === "none"
      ? `race none: the end left the view in ${result.wrong} painted frames (gaps ${result.gaps})`
      : `race ${input}: the timeline overrode the reader's move in ${result.wrong} painted frames (scrollTop ${result.tops}, the reader's ${result.moved})`);
  }
  const cached = await run(page, "cached");
  console.log(`cached\t${JSON.stringify(cached)}`);
  if (!cached.inFirstCommit) failures.push("cached: a remounted diagram did not show in its first commit");

  const many = await run(page, "many");
  console.log(`50 diagrams\t${JSON.stringify(many)}`);
  if ((many.drawnAtStart as number) > (many.near as number)) failures.push(`50 diagrams: ${many.drawnAtStart} drew before scrolling, only ${many.near} are near the view`);

  const hostile = await run(page, "hostile");
  console.log(`hostile\t${JSON.stringify(hostile)}`);
  for (const problem of hostile.problems as string[]) failures.push(`hostile: ${problem}`);

  // Fit: every gallery diagram at 1440, 768, and 390 px either fits its box with its smallest label at 11 px or more
  // (or at its own size, never scaled up), or scrolls inside it at that readable scale with a visible edge fade and
  // a labelled, focusable scroll region. Full size is always the natural size.
  for (const width of [1440, 768, 390]) {
    const gallery = await context.newPage();
    gallery.on("pageerror", (error) => failures.push(`gallery ${width}: ${error.message}`));
    await gallery.setViewportSize({ width, height: 900 });
    await gallery.goto(`http://127.0.0.1:${port}/gallery.html?theme=tokyo-night#Mermaid`);
    const done = gallery.locator('article[id^="mermaid-"][id$="-done"]:not(#mermaid-invalid-done)');
    await done.first().waitFor({ timeout: 120_000 });
    for (const card of await done.all()) {
      await card.scrollIntoViewIfNeeded();
      await card.locator("[data-part=mermaid-diagram] > svg").waitFor({ timeout: 60_000 });
    }
    const fits = await gallery.evaluate(() => [...document.querySelectorAll<HTMLElement>('article[id$="-done"] [data-part=mermaid-diagram]')].map((box) => {
      const svg = box.querySelector("svg")!;
      const natural = Math.ceil(svg.viewBox.baseVal.width); // the drawn size: sanitizeSvg rounds the viewBox up
      const scale = svg.getBoundingClientRect().width / natural;
      let least = Infinity;
      for (const text of svg.querySelectorAll("text")) if (text.textContent?.trim()) least = Math.min(least, parseFloat(getComputedStyle(text).fontSize));
      const overflows = box.scrollWidth > box.clientWidth + 1;
      const frame = box.parentElement!;
      const fade = getComputedStyle(frame, "::after");
      return {
        id: box.closest("article")!.id, box: box.clientWidth, natural: Math.round(natural), scale: Math.round(scale * 1000) / 1000,
        smallest: Math.round(least * scale * 10) / 10, natural_smallest: least, overflows,
        cue: overflows ? { fade: fade.content !== "none" && Number(fade.opacity) > 0.5 && parseFloat(fade.width) >= 16, region: box.tabIndex === 0 && box.getAttribute("role") === "region" && !!box.getAttribute("aria-label") } : null,
      };
    }));
    await gallery.close();
    for (const fit of fits) {
      console.log(`fit ${width}\t${JSON.stringify(fit)}`);
      const name = `fit ${width} ${fit.id}`;
      if (fit.scale > 1.001) failures.push(`${name}: scaled up to ${fit.scale}`);
      if (fit.scale < 0.999 && fit.smallest < 10.95) failures.push(`${name}: scaled to ${fit.scale}, its smallest label is ${fit.smallest} px (under 11)`);
      if (fit.overflows && !(fit.cue!.fade && fit.cue!.region)) failures.push(`${name}: overflows its ${fit.box} px box without a cue (${JSON.stringify(fit.cue)})`);
      if (fit.overflows && fit.scale * fit.natural_smallest > 11.05 && fit.scale < 0.999) failures.push(`${name}: scrolls though it could shrink further and stay readable`);
    }
  }

  // Width, keyboard, and theme, on one wide diagram at 390 px.
  await page.setViewportSize({ width: 390, height: 844 });
  await run(page, "single");
  const widths = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>("#single [data-part=mermaid-diagram]")!;
    return { box: box.clientWidth, content: box.scrollWidth, page: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  console.log(`390 px\t${JSON.stringify(widths)}`);
  if (widths.content <= widths.box) failures.push(`390 px: the wide diagram does not scroll in its box (${JSON.stringify(widths)})`);
  if (widths.page > widths.viewport) failures.push(`390 px: the page scrolls sideways (${widths.page} > ${widths.viewport})`);
  const label = await page.locator("#single [data-part=mermaid-diagram] > svg").getAttribute("aria-label");
  if (!label?.includes("a long first step")) failures.push(`the svg's label does not come from the diagram: ${label}`);
  if ((await page.locator("#single [data-part=mermaid-diagram] > svg").getAttribute("role")) !== "img") failures.push("the svg is not role=img");
  await page.locator("#single").evaluate((host) => (host.closest("body") as HTMLElement).focus());
  const reached: string[] = [];
  for (let i = 0; i < 40 && reached.length < 4; i++) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active?.closest("#single [data-part=mermaid-bar]") ? `${active.dataset.action}:${active.getAttribute("aria-label") ?? active.textContent}` : null;
    });
    if (focused && !reached.includes(focused)) reached.push(focused);
  }
  console.log(`keyboard\t${reached.join(" | ")}`);
  if (reached.join(" | ") !== "diagram:diagram | source:source | copy:copy source | open:open diagram full size") failures.push(`keyboard: the bar's controls by Tab were ${reached.join(" | ")}`);
  await page.keyboard.press("Enter"); // on open
  await page.locator("[data-part=mermaid-dialog][open] svg").waitFor({ timeout: 5000 }).catch(() => failures.push("keyboard: open did not show the full size dialog"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-part=mermaid-dialog]"), undefined, { timeout: 5000 }).catch(() => failures.push("keyboard: Escape did not close the dialog"));
  if ((await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action)) !== "open") failures.push("keyboard: focus did not return to open");
  await page.locator("#single [data-action=copy]").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  if (!copied.startsWith("flowchart LR\n  A[a long first step]")) failures.push(`copy gave ${JSON.stringify(copied.slice(0, 40))}`);

  const accent = () => page.evaluate(() => {
    const box = document.querySelector("#single [data-part=mermaid]")!;
    const probe = document.createElement("span");
    probe.style.color = "var(--fulcrum-accent)";
    box.append(probe);
    // as rgb(): a theme may declare its accent in another color space (computed as color(srgb ...))
    const pixel = document.createElement("canvas").getContext("2d")!;
    pixel.fillStyle = getComputedStyle(probe).color;
    pixel.fillRect(0, 0, 1, 1);
    const want = `rgb(${[...pixel.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(", ")})`;
    probe.remove();
    const node = box.querySelector("[data-part=mermaid-diagram] .node rect, [data-part=mermaid-diagram] .node path")!;
    return { want, stroke: getComputedStyle(node).stroke, svg: box.querySelector("[data-part=mermaid-diagram] > svg")!.id };
  });
  const light = await accent();
  await page.evaluate(() => document.documentElement.setAttribute("data-fulcrum-theme", "tokyo-night"));
  await page.waitForFunction((id) => document.querySelector("#single [data-part=mermaid-diagram] > svg")?.id !== id, light.svg, { timeout: 30_000 }).catch(() => failures.push("theme: the diagram was not redrawn"));
  const dark = await accent();
  console.log(`theme\t${JSON.stringify({ light, dark })}`);
  if (light.stroke !== light.want || dark.stroke !== dark.want || light.want === dark.want) failures.push(`theme: node borders ${light.stroke} / ${dark.stroke}, accents ${light.want} / ${dark.want}`);

  if (failures.length) throw new Error(failures.join("\n"));
  console.log("mermaid: ok");
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  await once(vite, "exit").catch(() => {});
  await rm(fixture, { force: true });
}
