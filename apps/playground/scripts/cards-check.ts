// Tool cards in the gallery. A capped box (output, arguments, numbered lines) that cuts its text says so: a fade on
// the cut edge and a control that shows the rest; after that control, nothing is cut. A pending approval is the
// timeline's first tab stop through a skip link. A streaming message ends its last text line with one terminal cursor,
// CanvasText under forced colors and still under reduced motion, and no fulcrum part animates under reduced motion even
// rendered outside a Timeline, while a host's own data-part widgets keep their motion.
import type { Browser, Page } from "playwright";

// The gallery's streaming messages, paused mid-stream (reduced motion at load), and what each must show. `cursors`: how
// many terminal cursors; `tag`: the element that draws it; `tight`: prose whose last line can be made to fill its
// width exactly, where the cursor must still not take a line of its own; `viewer`: a fence streaming as the code
// viewer, whose head carries the running mark instead; `open`: a control to click first.
type CursorCase = { id: string; cursors: 0 | 1; tag?: string; tight?: boolean; viewer?: boolean; open?: string };
const cursorCases: CursorCase[] = [
  { id: "message-streaming", cursors: 1, tight: true },
  { id: "content-streaming", cursors: 1 },
  { id: "message-plain-streaming", cursors: 1, tight: true },
  { id: "markdown-table-streaming", cursors: 1, tag: "td" },
  { id: "markdown-fence-streaming", cursors: 1, tag: "code" },
  // Ends in a closed fence: the block is final, so no cursor in it (it would add a line that the commit takes away).
  { id: "markdown-streaming", cursors: 0 },
  { id: "markdown-crossing", cursors: 0, viewer: true },
  // The text ended and a tool row runs below it: the tool holds the live signal.
  { id: "ai-sdk-text-then-tool", cursors: 0 },
  // An open reasoning block that streams shows its own state, not a cursor.
  { id: "reasoning-streaming", cursors: 0, open: "[data-part=reasoning] > summary" },
];
type Mode = "normal" | "forced colors" | "reduced motion";
const modes: [Mode, { reducedMotion: "no-preference" | "reduce"; forcedColors: "none" | "active" }][] = [
  ["normal", { reducedMotion: "no-preference", forcedColors: "none" }],
  ["forced colors", { reducedMotion: "no-preference", forcedColors: "active" }],
  ["reduced motion", { reducedMotion: "reduce", forcedColors: "none" }],
];

// Runs in the page. The streaming message's cursors (the ::after that styles.css draws with an empty content), their
// computed style, the height the cursor adds to the message (a line of its own makes it taller; the commit would take
// it away), and the running mark of a streaming viewer. The ::after shows in the accessibility tree as an unnamed
// generic node with no text: nothing is announced, and it is not a regression.
function readCursor(id: string) {
  const message = document.querySelector<HTMLElement>(`#${id} [data-part=message][data-state=streaming]`);
  if (!message) return undefined;
  const holders = [message, ...message.querySelectorAll<HTMLElement>("*")].filter((element) => getComputedStyle(element, "::after").content === '""');
  const probe = document.createElement("span");
  probe.style.color = "CanvasText";
  document.body.append(probe);
  const systemColor = getComputedStyle(probe).color;
  probe.remove();
  const height = message.getBoundingClientRect().height;
  const off = document.createElement("style");
  off.textContent = "[data-part=message] *::after, [data-part=message]::after { content: none !important; }";
  document.head.append(off);
  const without = message.getBoundingClientRect().height;
  off.remove();
  const mark = message.querySelector("[data-part=md-code-block][data-state=streaming] [data-part=text-viewer-count]");
  const markStyle = mark && getComputedStyle(mark, "::before");
  const look = (style: CSSStyleDeclaration) => ({ background: style.backgroundColor, adjust: style.forcedColorAdjust, animation: style.animationName });
  return {
    holders: holders.map((holder) => {
      const style = getComputedStyle(holder, "::after");
      return { tag: holder.tagName.toLowerCase(), width: parseFloat(style.width), height: parseFloat(style.height), marginLeft: style.marginLeft, ...look(style) };
    }),
    mark: markStyle && markStyle.content === '""' ? look(markStyle) : undefined,
    systemColor,
    extra: height - without,
  };
}

// Runs in the page. Narrows the message until its last text line, without the cursor, ends less than one cursor width
// from the line's edge, then reports how much height the cursor adds there (a cursor wrapped onto its own line).
function readTightFit(id: string) {
  const message = document.querySelector<HTMLElement>(`#${id} [data-part=message][data-state=streaming]`)!;
  const holder = [message, ...message.querySelectorAll<HTMLElement>("*")].find((element) => getComputedStyle(element, "::after").content === '""');
  if (!holder) return undefined;
  const block = getComputedStyle(holder).display === "inline" ? message : holder;
  const advance = parseFloat(getComputedStyle(holder, "::after").width) + 1;
  const off = document.createElement("style");
  off.textContent = "[data-part=message] *::after, [data-part=message]::after { content: none !important; }";
  const lastGlyph = () => {
    const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
    let last: Text | undefined;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent!.trim()) last = node as Text;
    const end = last!.textContent!.trimEnd().length;
    const range = document.createRange();
    range.setStart(last!, end - 1);
    range.setEnd(last!, end);
    return range.getBoundingClientRect().right;
  };
  const edge = () => block.getBoundingClientRect().right - parseFloat(getComputedStyle(block).paddingRight) - parseFloat(getComputedStyle(block).borderRightWidth);
  const start = message.getBoundingClientRect().width;
  try {
    for (let width = Math.floor(start); width > start - 400; width--) {
      message.style.width = `${width}px`;
      document.head.append(off);
      const slack = edge() - lastGlyph();
      const without = message.getBoundingClientRect().height;
      off.remove();
      if (slack >= 0 && slack < advance) return { slack, extra: message.getBoundingClientRect().height - without };
    }
    return undefined;
  } finally {
    off.remove();
    message.style.width = "";
  }
}

const nextFrame = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

type Look = { background: string; adjust: string; animation: string };
// One mode's rules for a live mark (the cursor blinks, the viewer's mark pulses): it moves with motion allowed, is
// CanvasText under forced colors, and is still under reduced motion.
function checkLook(at: string, mode: Mode, look: Look, animation: string, systemColor: string): string[] {
  if (mode === "normal" && look.animation !== animation) return [`${at}: animation is ${look.animation}, expected ${animation}`];
  if (mode === "forced colors" && (look.background !== systemColor || look.adjust !== "none")) return [`${at}: ${look.background}/${look.adjust}, expected CanvasText ${systemColor}/none`];
  if (mode === "reduced motion" && look.animation !== "none") return [`${at}: still animates (${look.animation})`];
  return [];
}

function checkCursorCase(at: string, mode: Mode, demo: CursorCase, cursor: NonNullable<ReturnType<typeof readCursor>>): string[] {
  if (cursor.holders.length !== demo.cursors) return [`${at}: ${cursor.holders.length} streaming cursors (${cursor.holders.map(({ tag }) => `<${tag}>`).join(", ")}), expected ${demo.cursors}`];
  const failures: string[] = [];
  // Whatever it shows, the commit (which removes the cursor) must not change the message's height.
  if (cursor.extra > 0.5) failures.push(`${at}: the cursor adds ${cursor.extra.toFixed(1)} px, a line that the commit takes away`);
  if (demo.viewer) failures.push(...(cursor.mark ? checkLook(`${at}: the viewer's running mark`, mode, cursor.mark, "fulcrum-pulse", cursor.systemColor) : [`${at}: the streaming viewer shows no running mark`]));
  const [holder] = cursor.holders;
  if (!holder) return failures;
  if (!(holder.width > 0 && holder.height > 0)) failures.push(`${at}: the cursor in <${holder.tag}> is ${holder.width}x${holder.height} px`);
  if (demo.tag && holder.tag !== demo.tag) failures.push(`${at}: the cursor is in <${holder.tag}>, expected <${demo.tag}>`);
  // A code cursor fills the next monospace cell: no gap off the character grid.
  if (holder.tag === "code" && holder.marginLeft !== "0px") failures.push(`${at}: the code cursor starts ${holder.marginLeft} off the next cell`);
  failures.push(...checkLook(`${at}: the cursor`, mode, holder, "fulcrum-blink", cursor.systemColor));
  return failures;
}

// The terminal cursor on real streaming markup, in each mode, plus the tight-fit case for prose.
async function checkStreamingCursor(page: Page, port: number, failures: string[]) {
  await page.goto(`http://127.0.0.1:${port}/gallery.html`);
  await page.waitForSelector(`#${cursorCases[0]!.id} [data-part=message]`, { state: "attached", timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  for (const demo of cursorCases) if (demo.open) await page.locator(`#${demo.id} ${demo.open}`).first().click({ timeout: 2_000 }).catch(() => failures.push(`${demo.id}: nothing to open at ${demo.open}`));
  const before = failures.length;
  for (const [mode, media] of modes) {
    await page.emulateMedia(media);
    for (const demo of cursorCases) {
      const at = `${demo.id} (${mode})`;
      // Off screen, a row skips layout (content-visibility) and reports a placeholder height.
      await page.locator(`#${demo.id}`).scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {}); // a missing demo fails below
      await nextFrame(page);
      const cursor = await page.evaluate(readCursor, demo.id);
      failures.push(...(cursor ? checkCursorCase(at, mode, demo, cursor) : [`${at}: no streaming message`]));
    }
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const demo of cursorCases.filter(({ tight }) => tight)) {
      await page.locator(`#${demo.id}`).scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await nextFrame(page);
      const fit = await page.evaluate(readTightFit, demo.id);
      if (!fit) failures.push(`${demo.id} @ ${width}: no width where the last line fills its box (the check found no case)`);
      else if (fit.extra > 0.5) failures.push(`${demo.id} @ ${width}: with the last line ${fit.slack.toFixed(1)} px from its edge, the cursor wraps onto its own line (+${fit.extra.toFixed(1)} px)`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  if (failures.length === before) console.log(`ok   streaming cursor: ${cursorCases.length} streaming messages show the expected cursor or running mark in normal, forced-colors, and reduced-motion modes, and a line that fills its width keeps the cursor on it`);

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${port}/gallery.html#approval-pending`);
  const approval = await page.waitForSelector("#approval-pending [data-part=approval]");
  const approvalState = await approval.evaluate((element) => ({ borderWidth: getComputedStyle(element).borderLeftWidth, text: element.textContent ?? "" }));
  if (approvalState.borderWidth !== "2px") failures.push(`approval-pending: forced-colors border is ${approvalState.borderWidth}, expected 2px`);
  if (!approvalState.text.trim()) failures.push("approval-pending: status words are not visible in forced colors");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
}

// Every part stays still under reduced motion even outside a Timeline or Composer: the gallery's rows (paused in their
// in-progress states) and composers, copied into a plain container, animate nowhere once reduced motion is on, and
// some did with it off, so the check sees real animations. A host widget that uses data-part for its own anatomy
// (Ark, Chakra, Zag) outside fulcrum keeps its animation and transition.
async function checkStandaloneMotion(page: Page, port: number, failures: string[]) {
  await page.goto(`http://127.0.0.1:${port}/gallery.html`);
  await page.waitForSelector(`#${cursorCases[0]!.id} [data-part=message]`, { state: "attached", timeout: 10_000 });
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "standalone-parts";
    for (const timeline of document.querySelectorAll("[data-part=timeline]")) for (const row of timeline.children) host.append(row.cloneNode(true));
    for (const composer of document.querySelectorAll("[data-part=composer]")) host.append(composer.cloneNode(true));
    document.body.append(host);
    const spinner = document.createElement("div");
    spinner.id = "host-spinner";
    spinner.dataset.scope = "spinner";
    spinner.dataset.part = "root";
    spinner.style.cssText = "animation: host-spin 1s linear infinite; transition: opacity 200ms";
    document.body.append(spinner);
  });
  const animated = () => page.evaluate(() => {
    const found = new Map<string, number>();
    for (const element of document.querySelectorAll<HTMLElement>("#standalone-parts *")) {
      for (const pseudo of [null, "::before", "::after"]) {
        const name = getComputedStyle(element, pseudo).animationName;
        if (name === "none") continue;
        const key = `${element.closest<HTMLElement>("[data-part]")?.dataset.part ?? element.tagName.toLowerCase()}${pseudo ?? ""} ${name}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
    return [...found].map(([key, count]) => `${key} x${count}`);
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const moving = await animated();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const still = await animated();
  const host = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector("#host-spinner")!);
    return { animation: style.animationName, transition: style.transitionDuration };
  });
  if (!moving.length) failures.push("standalone parts: nothing animates even with motion allowed (the check sees no animation)");
  if (still.length) failures.push(`standalone parts: ${still.length} animation(s) run under reduced motion outside a Timeline: ${still.join("; ")}`);
  else if (moving.length) console.log(`ok   standalone parts: ${moving.length} animation(s) outside a Timeline all stop under reduced motion (${moving.join("; ")})`);
  if (host.animation !== "host-spin" || host.transition !== "0.2s") failures.push(`host widget: a host's data-part="root" outside fulcrum lost its motion under reduced motion (animation ${host.animation}, transition ${host.transition})`);
  else console.log("ok   host widget: a host's own data-part widget outside fulcrum keeps its animation and transition under reduced motion");
}

export async function checkCards(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await checkStreamingCursor(page, port, failures);
  await checkStandaloneMotion(page, port, failures);
  await page.goto(`http://127.0.0.1:${port}/gallery.html#tools-done`);
  await page.waitForSelector("#tools-done [data-part=tool-body]");
  await page.waitForTimeout(500);
  const capped = await page.evaluate(() => {
    const found: { id: string; part: string; fade: string; control: boolean }[] = [];
    for (const node of document.querySelectorAll<HTMLElement>("#tools-done [data-part=tool-body] *")) {
      if (!["auto", "scroll"].includes(getComputedStyle(node).overflowY) || node.scrollHeight <= node.clientHeight + 4) continue;
      if (node.closest("[data-part=text-viewer]")) continue; // the open viewer scrolls by design and says where it is
      const id = node.closest<HTMLElement>("[data-part=tool]")!.dataset.id!;
      found.push({ id, part: node.dataset.part ?? node.tagName, fade: getComputedStyle(node).maskImage, control: !!node.parentElement?.querySelector(":scope > [data-action=expand]") });
    }
    return found;
  });
  if (!capped.length) failures.push("tools-done: no capped box to check (the fixture changed?)");
  for (const box of capped) {
    if (box.fade === "none") failures.push(`${box.id} ${box.part}: cut with no fade on its cut edge`);
    if (!box.control) failures.push(`${box.id} ${box.part}: cut with no control that shows the rest`);
  }
  if (!failures.length) {
    const left = await page.evaluate(() => {
      for (const button of document.querySelectorAll<HTMLButtonElement>("#tools-done [data-action=expand]")) button.click();
      return new Promise<number>((resolve) => requestAnimationFrame(() => resolve([...document.querySelectorAll<HTMLElement>("#tools-done [data-part=tool-body] *")]
        .filter((node) => !node.closest("[data-part=text-viewer]") && ["auto", "scroll"].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 4).length)));
    });
    if (left) failures.push(`tools-done: ${left} box(es) still cut after "show all"`);
    else console.log(`ok   tools-done: ${capped.length} capped box(es) fade and expand`);
  }
  // A large fence's constructs that cross 500-character range edges: once the whole block's colors arrive, every word of
  // the block comment is comment and every word of the docstring is string (or comment), never code.
  await page.goto(`http://127.0.0.1:${port}/gallery.html#markdown-large-constructs`);
  await page.waitForSelector("#markdown-large-constructs [data-part=text-viewer-row] .tok-comment", { timeout: 30_000 }).catch(() => {});
  const miscolored = () => page.evaluate(() => {
    const words: Record<string, string[]> = { lorem: [".tok-comment"], ipsum: [".tok-string", ".tok-comment"] };
    let found = 0;
    const off: string[] = [];
    const walker = document.createTreeWalker(document.getElementById("markdown-large-constructs")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const [word, classes] of Object.entries(words)) {
        if (!node.textContent!.includes(word) || !node.parentElement!.closest("[data-part=text-viewer-row]")) continue;
        found++;
        if (!classes.some((name) => node!.parentElement!.closest(name))) off.push(`${word} in ${node.parentElement!.className || "plain text"}`);
      }
    }
    return found < 2 ? ["the constructs are not on screen"] : off;
  });
  let wrong = await miscolored();
  for (let tries = 0; wrong.length && tries < 120; tries++) { // settles once the whole block's colors arrive
    await page.waitForTimeout(250);
    wrong = await miscolored();
  }
  if (wrong.length) failures.push(`markdown-large-constructs: ${wrong.length} piece(s) miscolored, e.g. ${wrong.slice(0, 3).join("; ")}`);
  else console.log("ok   markdown-large-constructs: a block comment and a docstring keep their colors across range edges");
  // A pending approval: the timeline's first tab stop is "jump to approval"; drawn on focus in the timeline's column,
  // over the top row on an opaque background (no row moves, ux-check.ts), and Enter puts focus on the approval's first
  // action, in view.
  await page.goto(`http://127.0.0.1:${port}/gallery.html#approval-pending`);
  const present = await page.waitForSelector("#approval-pending [data-part=jump-to-approval]", { state: "attached", timeout: 10_000 }).then(() => true, () => false);
  if (!present) {
    failures.push("approval-pending: no jump to approval control");
    await page.close();
    return failures;
  }
  const skip = await page.evaluate(async () => {
    const button = document.querySelector<HTMLElement>("#approval-pending [data-part=jump-to-approval]")!;
    const timeline = document.querySelector<HTMLElement>("#approval-pending [data-part=timeline]")!;
    const focusables = [...document.querySelectorAll<HTMLElement>("#approval-pending :is(button, summary, [tabindex], a[href])")].filter((node) => node.tabIndex >= 0 && (node === button || timeline.contains(node)));
    button.focus();
    const box = button.getBoundingClientRect();
    const shown = getComputedStyle(button).clipPath === "none" && box.width > 40 && box.height >= 24;
    const column = Math.round(box.left - timeline.getBoundingClientRect().left);
    const opaque = getComputedStyle(button).backgroundColor.match(/[\d.]+/g)!.length === 3 || getComputedStyle(button).backgroundColor.endsWith(", 1)");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const active = document.activeElement as HTMLElement;
    const rect = active.getBoundingClientRect();
    return { first: focusables[0] === button, shown, column, opaque, action: active.dataset.action, inView: rect.top >= 0 && rect.bottom <= innerHeight };
  });
  if (!skip.first) failures.push("approval-pending: jump to approval is not the timeline's first tab stop");
  if (!skip.shown) failures.push("approval-pending: jump to approval is not visible while focused");
  if (skip.column) failures.push(`approval-pending: jump to approval starts ${skip.column} px from the timeline's column`);
  if (!skip.opaque) failures.push("approval-pending: jump to approval is drawn over the timeline on a see-through background");
  if (skip.action !== "approve" || !skip.inView) failures.push(`approval-pending: jump focused ${skip.action ?? "nothing"} (${skip.inView ? "in view" : "out of view"}), expected approve in view`);
  if (skip.first && skip.shown && !skip.column && skip.opaque && skip.action === "approve" && skip.inView) console.log("ok   approval-pending: jump to approval is the first tab stop and focuses approve");
  await page.close();
  return failures;
}

if (import.meta.main) {
  const { chromium } = await import("playwright");
  const port = Number(process.env.PORT ?? 5173);
  const browser = await chromium.launch();
  const failures = await checkCards(browser, port).finally(() => browser.close());
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(failures.length ? 1 : 0);
}
