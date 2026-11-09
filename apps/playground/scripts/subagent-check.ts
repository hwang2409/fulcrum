// Sub-agent rows and drill-in, in the gallery's sub-agent demos. Every row is exactly 56 px (68 px with the row gap,
// the virtual timeline's estimate), whatever its state. Opening a row moves no layout: the run bar and the scroll box
// keep their place, and focus moves to the breadcrumb. Approving inside a grandchild clears the waiting badge on every
// level. Browser back and Escape each return one level, to the exact scroll position the parent was left at, with
// focus back on the row that opened it. In every theme, the run bar's text (crumbs, back, the waiting badge) reaches
// 4.5:1 and its state marks 3:1 on the background they are drawn on. The open path lives in the URL: reload and a
// deep link reopen it, and a run that cannot open falls back to its parent with a notice. The elapsed clock runs only
// while a live row is really on screen (not a virtual overscan row, not a hidden page). At 200% zoom and at the 320 px
// reflow width every row keeps its 56 px and no text is cut vertically or spills; long text ends in an ellipsis and
// stays whole in the row's title and accessible name.
import type { Browser, Page } from "playwright";

const ROW = 56;
const GAP = 12;

// Runs in the page: run-bar text at 4.5:1 and state marks at 3:1 against the color next to them (their bg ring, or the
// background composited up to an opaque one).
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
  // A mark ringed in a solid outline (styles.css rings each one in bg) is measured against its ring, the color next to it.
  for (const mark of bar.querySelectorAll('[data-part="run-state"]')) {
    const style = getComputedStyle(mark);
    const under = backgroundOf(mark.parentElement);
    const ringed = style.outlineStyle === "solid" && parseFloat(style.outlineWidth) >= 1 && parseFloat(style.outlineOffset) >= 0;
    const value = ratio(style.backgroundColor, ringed ? over(rgba(style.outlineColor), under) : under);
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
  return { bar: box('[data-part="run-bar"]'), scroll: box('[data-part="timeline-scroll"]') };
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
    const scroller = nav(page).locator('[data-part="timeline-scroll"]');
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

    await page.goBack();
    await page.waitForTimeout(250);
    if ((await crumbs(page)) !== 2) failures.push(`${at}: browser back left ${await crumbs(page)} crumbs, expected 2`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const back = await scroller.evaluate((node) => ({ scrollTop: node.scrollTop, row: node.querySelector('[data-id="sub-agent:reviewer"]')?.getBoundingClientRect().top ?? Number.NaN }));
    const backFocus = await focused(page);
    const urgency = await nav(page).locator('[data-id="sub-agent:reviewer"]').getAttribute("data-urgency");
    if ((await crumbs(page)) !== 1 || !page.url().includes("gallery.html")) failures.push(`${at}: Escape left ${await crumbs(page)} crumbs at ${page.url()}`);
    if (Math.abs(back.scrollTop - parent.scrollTop) > 1 || Math.abs(back.row - parent.row) > 1)
      failures.push(`${at}: back did not restore the parent: scrollTop ${parent.scrollTop} -> ${back.scrollTop}, row top ${parent.row} -> ${back.row}`);
    if (JSON.stringify(await rects(page)) !== JSON.stringify(before)) failures.push(`${at}: layout moved on back`);
    if (backFocus !== "row sub-agent:reviewer") failures.push(`${at}: focus after back is on ${backFocus}, expected the reviewer row`);
    if (urgency) failures.push(`${at}: the reviewer row still says ${urgency} after the approval`);
    if (errors.length) failures.push(`${at}: page errors: ${errors.join("; ")}`);
    if (!failures.some((failure) => failure.startsWith(at))) console.log(`ok   ${at}: drill-in, approve, browser back, Escape restore scroll ${back.scrollTop} and focus with no layout move`);
    await page.close();
  }

  failures.push(...await checkPathInUrl(browser, port));
  for (const navigationApi of [true, false]) failures.push(...await checkHostRouter(browser, port, navigationApi));
  failures.push(...await checkClock(browser, port));
  failures.push(...await checkZoom(browser, port));

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

async function checkPathInUrl(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const at = "sub-agent path in the url";
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${port}/gallery.html#run-navigator-nested`);
  await page.waitForSelector('#run-navigator-nested [data-part="sub-agent"]');
  await openRow(page, "reviewer");
  await openRow(page, "tester");
  const url = new URL(page.url());
  if (url.searchParams.getAll("run-navigator-nested").join(">") !== "reviewer>tester") failures.push(`${at}: url is ${page.url()} after opening reviewer > tester`);
  await page.reload();
  await page.waitForSelector('#run-navigator-nested [data-part="run-crumb"][aria-current="page"]');
  await page.waitForTimeout(300);
  if ((await crumbs(page)) !== 3) failures.push(`${at}: reload shows ${await crumbs(page)} crumbs, expected 3`);
  await page.goBack();
  await page.waitForTimeout(300);
  if ((await crumbs(page)) !== 2) failures.push(`${at}: browser back after reload shows ${await crumbs(page)} crumbs, expected 2`);
  await page.goto(`http://127.0.0.1:${port}/gallery.html?run-navigator-nested=reviewer&run-navigator-nested=docs-old#run-navigator-nested`);
  await page.waitForSelector('#run-navigator-nested [data-part="run-notice"]:not(:empty)');
  const notice = await nav(page).locator('[data-part="run-notice"]').textContent();
  const fellBack = new URL(page.url()).searchParams.getAll("run-navigator-nested");
  if ((await crumbs(page)) !== 2 || fellBack.join(">") !== "reviewer" || !notice?.startsWith("could not open"))
    failures.push(`${at}: a deep link to a run that cannot open shows ${await crumbs(page)} crumbs, url path ${fellBack.join(">")}, notice "${notice}"`);
  if (!failures.length) console.log(`ok   ${at}: reload reopens reviewer > tester, back pops one level, a bad deep link falls back with "${notice}"`);
  await page.close();
  return failures;
}

// The history helper never moves through the history list. A host router that opens its next route (keeping the query
// and merging history state) and then unmounts the page keeps its URL; a hash entry made after opening a run does not
// stop back from closing it. Checked with the Navigation API and with it removed.
async function checkHostRouter(browser: Browser, port: number, navigationApi: boolean): Promise<string[]> {
  const failures: string[] = [];
  const at = `sub-agent history under a host router (${navigationApi ? "with" : "without"} window.navigation)`;
  const key = "run-navigator-nested";
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  if (!navigationApi) await page.addInitScript(() => Object.defineProperty(window, "navigation", { configurable: true, value: undefined }));
  await page.goto(`http://127.0.0.1:${port}/gallery.html#${key}`);
  await page.waitForSelector(`#${key} [data-part="sub-agent"]`);
  if (await page.evaluate(() => "navigation" in window && !!(window as { navigation?: unknown }).navigation) !== navigationApi)
    failures.push(`${at}: window.navigation is not ${navigationApi ? "present" : "removed"}`);

  await openRow(page, "reviewer");
  await page.evaluate(() => { location.hash = "section"; });
  await page.waitForTimeout(150);
  await nav(page).locator('[data-part="run-back"]').click();
  await page.waitForTimeout(250);
  const closed = new URL(page.url());
  if ((await crumbs(page)) !== 1 || closed.searchParams.getAll(key).length || closed.hash !== "#section")
    failures.push(`${at}: back after a hash entry shows ${await crumbs(page)} crumbs at ${page.url()}, expected the root at #section`);

  await openRow(page, "reviewer");
  const routed = await page.evaluate((key) => {
    history.pushState({ ...history.state, router: "b" }, "", `/route-b?${key}=reviewer`);
    const length = history.length;
    (window as { unmountGallery?: () => void }).unmountGallery!();
    return length;
  }, key);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ url: location.pathname + location.search, length: history.length, router: (history.state as { router?: string } | null)?.router }));
  if (after.url !== `/route-b?${key}=reviewer` || after.length !== routed || after.router !== "b")
    failures.push(`${at}: unmounting after the router moved left ${JSON.stringify(after)}, expected /route-b?${key}=reviewer with ${routed} entries`);
  if (!failures.length) console.log(`ok   ${at}: back closes the run past a hash entry, unmount keeps the router's /route-b`);
  await page.close();
  return failures;
}

// Counts the running 1 s intervals in the page (the only 1 s interval is the sub-agent clock; demos replay faster).
const countIntervals = () => {
  const active = new Set<number>();
  const [set, clear] = [window.setInterval.bind(window), window.clearInterval.bind(window)];
  window.setInterval = ((run: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const timer = set(run, ms, ...rest);
    if (ms === 1_000) active.add(timer);
    return timer;
  }) as typeof setInterval;
  window.clearInterval = (timer?: number) => {
    if (timer !== undefined) active.delete(timer);
    clear(timer);
  };
  (window as unknown as { clocks(): number }).clocks = () => active.size;
};

async function checkClock(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const at = "sub-agent clock";
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.addInitScript(countIntervals);
  await page.goto(`http://127.0.0.1:${port}/gallery.html`);
  await page.waitForSelector('#subagent-states [data-part="sub-agent"]');
  const clocks = async () => {
    await page.waitForTimeout(250);
    return page.evaluate(() => (window as unknown as { clocks(): number }).clocks());
  };
  const expect = async (what: string, want: number) => {
    const got = await clocks();
    if (got !== want) failures.push(`${at}: ${what}: ${got} clock intervals running, expected ${want}`);
  };
  await expect("live rows mounted far below the window", 0);
  await page.locator("#subagent-states").scrollIntoViewIfNeeded();
  await expect("live rows in view", 1);
  const hide = (hidden: boolean) => page.evaluate((hidden) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await hide(true);
  await expect("page hidden", 0);
  await hide(false);
  await expect("page visible again", 1);

  // A live row that is mounted (virtual overscan) but outside its scroll box, with every other live row off screen.
  const setup = await page.evaluate(() => {
    const card = document.getElementById("run-navigator-nested")!;
    const navigator = card.querySelector<HTMLElement>('[data-part="run-navigator"]')!;
    navigator.style.height = "240px";
    card.scrollIntoView({ block: "start" });
    const scroller = navigator.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
    const row = scroller.querySelector<HTMLElement>('[data-part="sub-agent"][data-id="sub-agent:reviewer"]')!;
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom - 24;
    return new Promise<string>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const box = scroller.getBoundingClientRect();
      const mounted = scroller.querySelector('[data-part="sub-agent"][data-id="sub-agent:reviewer"]');
      const rect = mounted?.getBoundingClientRect();
      const live = [...document.querySelectorAll<HTMLElement>('[data-part="sub-agent"]')].filter((node) => !["done", "error", "canceled"].includes(node.dataset.state!));
      const onScreen = live.filter((node) => {
        const r = node.getBoundingClientRect();
        const clip = node.closest('[data-part="timeline-scroll"]')?.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && (!clip || (r.bottom > clip.top && r.top < clip.bottom));
      });
      if (!rect) resolve("the reviewer row is not mounted below the scroll box, so this is not an overscan case");
      else if (rect.top < box.bottom) resolve(`the reviewer row is not below the scroll box (${rect.top} < ${box.bottom})`);
      else if (onScreen.length) resolve(`${onScreen.length} live rows still on screen: ${onScreen.map((node) => node.dataset.id).join(", ")}`);
      else resolve("");
    })));
  });
  if (setup) failures.push(`${at}: overscan setup: ${setup}`);
  else await expect("only an overscan live row mounted", 0);
  if (!failures.length) console.log(`ok   ${at}: 0 intervals off screen, 1 in view, 0 hidden, 1 visible again, 0 with only an overscan row`);
  await page.close();
  return failures;
}

// Runs in the page: every row's text inside its 56 px box, long text ellipsized, and the whole text in title and name.
function rowProblems() {
  const problems: string[] = [];
  for (const row of document.querySelectorAll<HTMLElement>('#subagent-states [data-part="sub-agent"]')) {
    const id = row.dataset.id;
    const box = row.getBoundingClientRect();
    if (Math.abs(box.height - 56) > 0.5) problems.push(`${id} is ${box.height} px tall`);
    for (const part of row.querySelectorAll<HTMLElement>('[data-part^="sub-agent-"]')) {
      if (part.dataset.part === "sub-agent-head" || part.dataset.part === "sub-agent-line" || !part.getClientRects().length) continue;
      const r = part.getBoundingClientRect();
      if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) problems.push(`${id} ${part.dataset.part} is cut vertically (${r.top}-${r.bottom} in ${box.top}-${box.bottom})`);
      if (r.right > box.right + 0.5 && r.width > 0) problems.push(`${id} ${part.dataset.part} spills past the row (${r.right} > ${box.right})`);
      if (part.scrollWidth > part.clientWidth + 1 && getComputedStyle(part).textOverflow !== "ellipsis") problems.push(`${id} ${part.dataset.part} is cut with no ellipsis`);
    }
    const task = row.querySelector('[data-part="sub-agent-task"]')?.textContent ?? "";
    if (!row.title.includes(task)) problems.push(`${id} title does not hold the whole task`);
    if (row.tagName === "BUTTON" && !row.getAttribute("aria-label")?.includes(task)) problems.push(`${id} accessible name does not hold the whole task`);
  }
  const long = document.querySelector<HTMLElement>('#subagent-states [data-id="sub-agent:st-long"] [data-part="sub-agent-task"]');
  if (!long || long.scrollWidth <= long.clientWidth) problems.push("the long row's task is not truncated, so the ellipsis case is not exercised");
  return problems;
}

async function checkZoom(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  // 200% zoom of a 1440 x 900 window is a 720 x 450 CSS px viewport at 2 device pixels per CSS px; 320 is the reflow width.
  for (const [width, height] of [[720, 450], [320, 640]] as const) {
    const at = `sub-agent rows at ${width} css px, 2x`;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${port}/gallery.html#subagent-states`);
    await page.waitForSelector('#subagent-states [data-part="sub-agent"]');
    await page.waitForTimeout(200);
    const problems = await page.evaluate(rowProblems);
    for (const problem of problems) failures.push(`${at}: ${problem}`);
    if (!problems.length) console.log(`ok   ${at}: every row 56 px, no text cut or spilling, long text ellipsized and whole in title and name`);
    await page.close();
  }
  return failures;
}
