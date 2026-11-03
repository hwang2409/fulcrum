// Mermaid fences in real chromium (vite's dev server with production react). Fails when:
// - the diagram swap moves the reading position by more than 1 px in any painted frame (the gap to the bottom while
//   the virtual timeline follows; the first row in view otherwise), with the diagram at the bottom, just above the
//   viewport, or below it, in virtual and plain timelines; when the box passes through any height between its source
//   and its diagram (a blank or collapsed frame); or when the svg is inserted more than once;
// - a remounted diagram does not show from the cache in its first commit;
// - with 50 diagrams, any diagram far from the view draws before it is scrolled near, or they do not all draw;
// - hostile diagrams (html labels, click callbacks, javascript: links, outside urls, init/frontmatter overrides) get
//   html, script, a link, or an outside url into the page, or sanitizeSvg keeps one;
// - the page fetches mermaid before the first fence closes;
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
  const cached = await run(page, "cached");
  console.log(`cached\t${JSON.stringify(cached)}`);
  if (!cached.inFirstCommit) failures.push("cached: a remounted diagram did not show in its first commit");

  const many = await run(page, "many");
  console.log(`50 diagrams\t${JSON.stringify(many)}`);
  if ((many.drawnAtStart as number) > (many.near as number)) failures.push(`50 diagrams: ${many.drawnAtStart} drew before scrolling, only ${many.near} are near the view`);

  const hostile = await run(page, "hostile");
  console.log(`hostile\t${JSON.stringify(hostile)}`);
  for (const problem of hostile.problems as string[]) failures.push(`hostile: ${problem}`);

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
    const want = getComputedStyle(probe).color;
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
