// Collapsed tool bodies are warmed before they open: a card in view, or hovered, shows syntax tokens on the first frame its
// body paints once its warm request was answered (the check waits for that answer, never for a fixed time). A cold open may paint plain text first, but with the exact size of the
// highlighted text. Once warming is done, a still page schedules no idle callbacks and posts no highlight requests.
// The native summary reports its expanded state in Chromium's accessibility tree, before and after the body mounts.
import type { Browser, Page } from "playwright";

type Counters = { idle: number; posts: number };
type Opened = { frames: number; tokens: number; width: number; height: number };

// Counts idle callbacks the page schedules and highlight requests it posts to a worker, and records, per block id, whether
// the newest posted revision has its final tokens: a reply produced with its fully loaded grammar, or the update that
// follows a cold reply. `idle: false` makes requestIdleCallback never fire, so only hover can warm a card.
const instrument = (page: Page, idle: boolean) => page.addInitScript((idle) => {
  const counters = { idle: 0, posts: 0 };
  const blocks = new Map<string, { version: number; final: boolean }>();
  const requests = new Map<number, { id: string; version: number }>();
  const settle = (id: string, version: number) => { const block = blocks.get(id); if (block?.version === version) block.final = true; };
  Object.assign(window, { __warm: counters, __blocks: blocks });
  const request = window.requestIdleCallback?.bind(window);
  window.requestIdleCallback = ((callback: IdleRequestCallback, options?: IdleRequestOptions) => {
    counters.idle++;
    return idle && request ? request(callback, options) : 0;
  }) as typeof window.requestIdleCallback;
  type Message = { type?: string; requestId: number; context: { id: string; version: number } };
  type Reply = { requestId?: number; provenance?: { fullyLoaded: boolean }; update?: { id: string; version: number } };
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: [StructuredSerializeOptions?]) {
    const { type, requestId, context } = message as Message;
    if (type === "highlight") {
      counters.posts++;
      requests.set(requestId, context);
      if (context.version >= (blocks.get(context.id)?.version ?? -1)) blocks.set(context.id, { version: context.version, final: false });
    }
    return post.call(this, message, ...rest);
  } as typeof Worker.prototype.postMessage;
  const Base = Worker;
  window.Worker = class extends Base {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", (event) => {
        const reply = event.data as Reply;
        if (reply.update) settle(reply.update.id, reply.update.version);
        else if (reply.provenance?.fullyLoaded) { const sent = requests.get(reply.requestId!); if (sent) settle(sent.id, sent.version); }
      });
    }
  };
}, idle);

// The handshake, instead of a fixed wait: resolves once the card's body blocks were posted and each has its final tokens.
const bodyFinal = (page: Page, id: string) => page.waitForFunction((id) => {
  const blocks = [...(window as unknown as { __blocks: Map<string, { final: boolean }> }).__blocks]
    .filter(([block]) => block.startsWith(`${id}:`) && !block.endsWith(":summary"));
  return blocks.length > 0 && blocks.every(([, block]) => block.final);
}, id, { timeout: 20_000 }).then(() => true, () => false);

// Every block the page asked for has its final tokens.
const allFinal = (page: Page) => page.waitForFunction(() =>
  [...(window as unknown as { __blocks: Map<string, { final: boolean }> }).__blocks.values()].every((block) => block.final), undefined, { timeout: 20_000 }).then(() => true, () => false);

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

  // In view: idle warming posts the body's request; once the worker answered it, the body opens colored.
  const viewed = "tool:done-read";
  if (!(await collapsed(page, viewed))) failures.push(`warm: ${viewed} does not start collapsed and unmounted`);
  const before = await summaryNode(page, viewed);
  await page.$eval(`[data-id="${viewed}"]`, (card) => card.scrollIntoView({ block: "center" }));
  if (!(await bodyFinal(page, viewed))) failures.push(`warm: ${viewed} in view: its body blocks were never posted and answered in 20 s`);
  const inView = await open(page, viewed);
  const opened = await summaryNode(page, viewed);
  await page.$eval(`[data-id="${viewed}"] > summary`, (summary) => (summary as HTMLElement).click());
  await page.waitForTimeout(50);
  const closed = await summaryNode(page, viewed);
  const ax = `${before.role} expanded ${before.expanded} → open ${opened.expanded} → closed ${closed.expanded}`;
  if (before.expanded !== false || opened.expanded !== true || closed.expanded !== false) failures.push(`warm: summary accessibility state is wrong: ${ax}`);
  else console.log(`ok   warm: summary accessibility tree: ${ax}`);
  if (!inView.tokens) failures.push(`warm: ${viewed} in view, warm request answered, painted its body with no tokens on frame ${inView.frames}`);
  else console.log(`ok   warm: ${viewed} in view, warm request answered: ${inView.tokens} token spans on the first body frame (frame ${inView.frames} after the click)`);

  // A still page: once every block has its final tokens, 5 s with no idle callbacks and no highlight requests.
  if (!(await allFinal(page))) failures.push("warm: some posted block never got its final tokens in 20 s");
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
  if (!(await allFinal(still))) failures.push("warm: some posted block never got its final tokens in 20 s (no idle warming)");
  const hovered = "tool:done-read-py";
  if (!(await collapsed(still, hovered))) failures.push(`warm: ${hovered} does not start collapsed and unmounted`);
  await still.hover(`[data-id="${hovered}"] > summary`);
  if (!(await bodyFinal(still, hovered))) failures.push(`warm: hovering ${hovered} never posted and answered its body blocks in 20 s`);
  const afterHover = await open(still, hovered);
  if (!afterHover.tokens) failures.push(`warm: ${hovered} hovered, warm request answered, painted its body with no tokens on frame ${afterHover.frames}`);
  else console.log(`ok   warm: ${hovered} hovered, warm request answered: ${afterHover.tokens} token spans on the first body frame (frame ${afterHover.frames} after the click)`);

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
