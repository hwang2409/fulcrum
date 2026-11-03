// Collapsed tool bodies are warmed before they open: a card in view for 500 ms, or hovered for 150 ms, shows syntax
// tokens on the first frame its body paints. A cold open may paint plain text first, but with the exact size of the
// highlighted text. Once warming is done, a still page schedules no idle callbacks and posts no highlight requests.
// The native summary reports its expanded state in Chromium's accessibility tree, before and after the body mounts.
import type { Browser, Page } from "playwright";

type Counters = { idle: number; posts: number };
type Opened = { frames: number; tokens: number; width: number; height: number };

// Counts idle callbacks the page schedules and highlight requests it posts to a worker. `idle: false` makes
// requestIdleCallback never fire, so only hover can warm a card.
const instrument = (page: Page, idle: boolean) => page.addInitScript((idle) => {
  const counters = { idle: 0, posts: 0 };
  (window as unknown as { __warm: typeof counters }).__warm = counters;
  const request = window.requestIdleCallback?.bind(window);
  window.requestIdleCallback = ((callback: IdleRequestCallback, options?: IdleRequestOptions) => {
    counters.idle++;
    return idle && request ? request(callback, options) : 0;
  }) as typeof window.requestIdleCallback;
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: [StructuredSerializeOptions?]) {
    if ((message as { type?: string })?.type === "highlight") counters.posts++;
    return post.call(this, message, ...rest);
  } as typeof Worker.prototype.postMessage;
}, idle);

const counters = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __warm: Counters }).__warm }));

// Opens the card with a plain click (no pointer events, so no pointer warming) and reads the first frame its body is in.
const open = (page: Page, id: string) => page.evaluate(async (id) => {
  const card = document.querySelector<HTMLDetailsElement>(`[data-id="${id}"]`)!;
  card.querySelector("summary")!.click();
  for (let frames = 1; ; frames++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const body = card.querySelector<HTMLElement>('[data-part="tool-body"]');
    if (body || frames === 30) {
      const rect = body?.getBoundingClientRect();
      return { frames, tokens: body?.querySelectorAll('[class*="tok-"]').length ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0 };
    }
  }
}, id) as Promise<Opened>;

const settled = (page: Page, id: string) => page.evaluate(async (id) => {
  const body = document.querySelector<HTMLElement>(`[data-id="${id}"] [data-part="tool-body"]`)!;
  for (let i = 0; i < 300 && !body.querySelector('[class*="tok-"]'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const rect = body.getBoundingClientRect();
  return { frames: 0, tokens: body.querySelectorAll('[class*="tok-"]').length, width: rect.width, height: rect.height };
}, id) as Promise<Opened>;

const collapsed = (page: Page, id: string) => page.$eval(`[data-id="${id}"]`, (card) => !(card as HTMLDetailsElement).open && !card.querySelector('[data-part="tool-body"]'));

// Chromium's accessibility node for the card's summary: its role and expanded state.
async function summaryNode(page: Page, id: string) {
  const cdp = await page.context().newCDPSession(page);
  const { result } = await cdp.send("Runtime.evaluate", { expression: `document.querySelector('[data-id="${id}"] > summary')` });
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { objectId: result.objectId, fetchRelatives: false });
  await cdp.detach();
  const node = nodes[0]!;
  const expanded = node.properties?.find((property) => property.name === "expanded")?.value.value;
  return { role: String(node.role?.value), expanded: expanded as boolean | undefined };
}

export async function checkWarmBodies(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const url = `http://127.0.0.1:${port}/gallery.html#tools-done`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await instrument(page, true);
  await page.goto(url);
  await page.waitForSelector('[data-id="tool:done-read"]', { state: "attached" });

  // In view for 500 ms.
  const viewed = "tool:done-read";
  if (!(await collapsed(page, viewed))) failures.push(`warm: ${viewed} does not start collapsed and unmounted`);
  const before = await summaryNode(page, viewed);
  await page.$eval(`[data-id="${viewed}"]`, (card) => card.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(500);
  const inView = await open(page, viewed);
  const opened = await summaryNode(page, viewed);
  await page.$eval(`[data-id="${viewed}"] > summary`, (summary) => (summary as HTMLElement).click());
  await page.waitForTimeout(50);
  const closed = await summaryNode(page, viewed);
  const ax = `${before.role} expanded ${before.expanded} → open ${opened.expanded} → closed ${closed.expanded}`;
  if (before.expanded !== false || opened.expanded !== true || closed.expanded !== false) failures.push(`warm: summary accessibility state is wrong: ${ax}`);
  else console.log(`ok   warm: summary accessibility tree: ${ax}`);
  if (!inView.tokens) failures.push(`warm: ${viewed} in view 500 ms painted its body with no tokens on frame ${inView.frames}`);
  else console.log(`ok   warm: ${viewed} in view 500 ms: ${inView.tokens} token spans on the first body frame (frame ${inView.frames} after the click)`);

  // A still page: once warming is done, 5 s with no idle callbacks and no highlight requests.
  await page.waitForTimeout(2_000);
  const start = await counters(page);
  await page.waitForTimeout(5_000);
  const end = await counters(page);
  if (end.idle !== start.idle || end.posts !== start.posts) failures.push(`warm: a still page scheduled ${end.idle - start.idle} idle callback(s) and posted ${end.posts - start.posts} highlight request(s) in 5 s`);
  else console.log(`ok   warm: a still page scheduled 0 idle callbacks and posted 0 highlight requests in 5 s (warming used ${start.idle} idle callbacks, ${start.posts} requests)`);
  await page.close();

  // No idle warming: hover warms; a cold open paints plain text at the exact highlighted size.
  const still = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await instrument(still, false);
  await still.goto(url);
  await still.waitForSelector('[data-id="tool:done-read-py"]', { state: "attached" });
  // A settled page: the worker has answered the headers' own requests, as it has by the time a reader hovers.
  await still.waitForTimeout(1_000);
  const hovered = "tool:done-read-py";
  if (!(await collapsed(still, hovered))) failures.push(`warm: ${hovered} does not start collapsed and unmounted`);
  await still.hover(`[data-id="${hovered}"] > summary`);
  await still.waitForTimeout(150);
  const afterHover = await open(still, hovered);
  if (!afterHover.tokens) failures.push(`warm: ${hovered} hovered 150 ms painted its body with no tokens on frame ${afterHover.frames}`);
  else console.log(`ok   warm: ${hovered} hovered 150 ms: ${afterHover.tokens} token spans on the first body frame (frame ${afterHover.frames} after the click)`);

  const cold = "tool:done-fetch-html";
  if (!(await collapsed(still, cold))) failures.push(`warm: ${cold} does not start collapsed and unmounted`);
  const coldOpen = await open(still, cold);
  const coldDone = await settled(still, cold);
  const size = `${coldOpen.width}x${coldOpen.height} with ${coldOpen.tokens} tokens → ${coldDone.width}x${coldDone.height} with ${coldDone.tokens} tokens`;
  if (!coldDone.tokens || Math.abs(coldOpen.width - coldDone.width) > 0.5 || Math.abs(coldOpen.height - coldDone.height) > 0.5) failures.push(`warm: cold open of ${cold} changed size or never highlighted: ${size}`);
  else console.log(`ok   warm: cold open of ${cold} keeps its size: ${size}`);
  await still.close();
  return failures;
}
