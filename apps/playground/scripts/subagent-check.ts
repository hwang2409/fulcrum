// Sub-agent rows and drill-in, in the gallery's sub-agent demos. Every row is exactly 56 px (68 px with the row gap,
// the virtual timeline's estimate), whatever its state. Opening a row moves no layout: the run bar and the scroll box
// keep their place, and focus moves to the breadcrumb. Approving inside a grandchild clears the waiting badge on every
// level. Escape and browser back each return one level, to the exact scroll position the parent was left at, with
// focus back on the row that opened it. In every theme, the run bar's text (crumbs, back, the waiting badge) reaches
// 4.5:1 and its state marks 3:1 on the background they are drawn on.
import type { Browser, Page } from "playwright";

const ROW = 56;
const GAP = 12;

// Runs in the page: run-bar text at 4.5:1 and state marks at 3:1, compositing backgrounds up to an opaque one.
function barContrast() {
  const pixel = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
  const rgba = (color: string) => {
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = color;
    pixel.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  const over = (top: number[], bottom: number[]) => top.slice(0, 3).map((c, i) => c * top[3]! + bottom[i]! * (1 - top[3]!)).concat(1);
  const luminance = (c: number[]) => c.slice(0, 3).map((v) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const backgroundOf = (start: Element | null) => {
    const layers: number[][] = [];
    for (let node = start; node; node = node.parentElement) if (layers.at(-1)?.[3] !== 1) layers.push(rgba(getComputedStyle(node).backgroundColor));
    return layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]);
  };
  const ratio = (color: string, background: number[]) => {
    const [light, dark] = [luminance(over(rgba(color), background)), luminance(background)].sort((a, b) => b - a);
    return (light! + 0.05) / (dark! + 0.05);
  };
  const problems: string[] = [];
  const bar = document.querySelector('#run-navigator-nested [data-part="run-bar"]')!;
  const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const node = text.parentElement!;
    if (!text.textContent!.trim() || !node.getClientRects().length) continue;
    const value = ratio(getComputedStyle(node).color, backgroundOf(node));
    if (value < 4.5) problems.push(`run bar text "${text.textContent!.trim()}" is ${value.toFixed(2)}:1, needs 4.5:1`);
  }
  for (const mark of bar.querySelectorAll('[data-part="run-state"]')) {
    const value = ratio(getComputedStyle(mark).backgroundColor, backgroundOf(mark.parentElement));
    if (value < 3) problems.push(`run bar state mark (${(mark as HTMLElement).dataset.state}) is ${value.toFixed(2)}:1, needs 3:1`);
  }
  if (!bar.querySelector('[data-part="run-urgency"]')) problems.push("run bar shows no waiting badge for the grandchild's pending approval");
  return problems;
}

const nav = (page: Page) => page.locator('#run-navigator-nested [data-part="run-navigator"]');
const crumbs = (page: Page) => nav(page).locator('[data-part="run-breadcrumb"] li').count();
const openRow = async (page: Page, runId: string) => {
  await nav(page).locator(`[data-part="sub-agent"][data-id="sub-agent:${runId}"]`).click();
  await page.waitForTimeout(150);
};
const rects = (page: Page) => nav(page).evaluate((root) => {
  const box = (selector: string) => {
    const rect = root.querySelector(selector)!.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  };
  return { bar: box('[data-part="run-bar"]'), scroll: box('[data-part="run-scroll"]') };
});
const focused = (page: Page) => page.evaluate(() => {
  const node = document.activeElement as HTMLElement | null;
  return node?.dataset.part === "sub-agent" ? `row ${node.dataset.id}` : node?.getAttribute("aria-current") === "page" ? "current crumb" : node?.outerHTML.slice(0, 60) ?? "nothing";
});

export async function checkSubAgents(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  let themes: string[] = [];
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/gallery.html#run-navigator-nested`);
    await page.waitForSelector('#subagent-states [data-part="sub-agent"]');
    await page.waitForTimeout(300);
    if (!themes.length) themes = await page.$$eval("#theme option", (options) => options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== "auto"));
    const at = `sub-agent @ ${width}`;

    const sizes = await page.$$eval('[data-part="sub-agent"]', (rows) => rows.map((row) => [row.getAttribute("data-id"), row.getBoundingClientRect().height, row.closest("[data-virtual-id]")?.getBoundingClientRect().height ?? -1] as const));
    const wrong = sizes.filter(([, row, slot]) => Math.abs(row - ROW) > 0.5 || Math.abs(slot - ROW - GAP) > 0.5);
    if (sizes.length < 8 || wrong.length) failures.push(`${at}: rows must be ${ROW} px (${ROW + GAP} px slots), got ${JSON.stringify(wrong)} of ${sizes.length}`);
    else console.log(`ok   ${at}: ${sizes.length} rows, each ${ROW} px in a ${ROW + GAP} px slot`);

    // Read from above the bottom (follow released), with the reviewer row in view.
    const scroller = nav(page).locator('[data-part="run-scroll"]');
    const up = await scroller.evaluate((node) => {
      const row = node.querySelector<HTMLElement>('[data-part="sub-agent"][data-id="sub-agent:reviewer"]')!;
      // As far up as keeps the whole row in view, at most 150 px.
      return Math.round(Math.min(150, node.getBoundingClientRect().top + node.clientHeight - row.getBoundingClientRect().bottom - 4));
    });
    await scroller.hover({ position: { x: 20, y: 20 } });
    await page.mouse.wheel(0, -up);
    await page.waitForTimeout(250);
    const before = await rects(page);
    const parent = await scroller.evaluate((node) => ({ scrollTop: node.scrollTop, row: node.querySelector('[data-id="sub-agent:reviewer"]')!.getBoundingClientRect().top, bottom: node.scrollHeight - node.clientHeight - node.scrollTop }));
    if (parent.bottom < 50) failures.push(`${at}: could not scroll the parent away from its bottom (${parent.bottom.toFixed(0)} px), the restore check is moot`);

    await openRow(page, "reviewer");
    const opened = await rects(page);
    const openFocus = await focused(page);
    if ((await crumbs(page)) !== 2) failures.push(`${at}: opening reviewer shows ${await crumbs(page)} crumbs, expected 2`);
    if (JSON.stringify(opened) !== JSON.stringify(before)) failures.push(`${at}: layout moved on drill-in: ${JSON.stringify(before)} -> ${JSON.stringify(opened)}`);
    if (openFocus !== "current crumb") failures.push(`${at}: focus after opening is on ${openFocus}, expected the current crumb`);

    await openRow(page, "tester");
    if ((await crumbs(page)) !== 3) failures.push(`${at}: opening tester shows ${await crumbs(page)} crumbs, expected 3`);
    const badges = await nav(page).locator('[data-part="run-urgency"]').count();
    await nav(page).locator('[data-action="approve"]').click();
    await page.waitForTimeout(150);
    const after = await nav(page).locator('[data-part="run-urgency"]').count();
    if (badges !== 2 || after !== 0) failures.push(`${at}: waiting badges in the breadcrumb went ${badges} -> ${after} on approve, expected 2 -> 0`);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    if ((await crumbs(page)) !== 2) failures.push(`${at}: Escape left ${await crumbs(page)} crumbs, expected 2`);
    await page.goBack();
    await page.waitForTimeout(400);
    const back = await scroller.evaluate((node) => ({ scrollTop: node.scrollTop, row: node.querySelector('[data-id="sub-agent:reviewer"]')?.getBoundingClientRect().top ?? Number.NaN }));
    const backFocus = await focused(page);
    const urgency = await nav(page).locator('[data-id="sub-agent:reviewer"]').getAttribute("data-urgency");
    if ((await crumbs(page)) !== 1 || !page.url().includes("gallery.html")) failures.push(`${at}: browser back left ${await crumbs(page)} crumbs at ${page.url()}`);
    if (Math.abs(back.scrollTop - parent.scrollTop) > 1 || Math.abs(back.row - parent.row) > 1)
      failures.push(`${at}: back did not restore the parent: scrollTop ${parent.scrollTop} -> ${back.scrollTop}, row top ${parent.row} -> ${back.row}`);
    if (JSON.stringify(await rects(page)) !== JSON.stringify(before)) failures.push(`${at}: layout moved on back`);
    if (backFocus !== "row sub-agent:reviewer") failures.push(`${at}: focus after back is on ${backFocus}, expected the reviewer row`);
    if (urgency) failures.push(`${at}: the reviewer row still says ${urgency} after the approval`);
    if (errors.length) failures.push(`${at}: page errors: ${errors.join("; ")}`);
    if (!failures.some((failure) => failure.startsWith(at))) console.log(`ok   ${at}: drill-in, approve, Escape, browser back restore scroll ${back.scrollTop} and focus with no layout move`);
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  for (const theme of themes) {
    await page.goto(`http://127.0.0.1:${port}/gallery.html?theme=${theme}#run-navigator-nested`);
    await page.waitForSelector('#run-navigator-nested [data-part="sub-agent"]');
    await openRow(page, "reviewer");
    await openRow(page, "tester");
    const problems = await page.evaluate(barContrast);
    for (const problem of problems) failures.push(`${theme}: ${problem}`);
    if (!problems.length) console.log(`ok   ${theme}: run bar contrast`);
  }
  await page.close();
  return failures;
}
