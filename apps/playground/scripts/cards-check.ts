// Tool cards in the gallery. A capped box (output, arguments, numbered lines) that cuts its text says so: a fade on
// the cut edge and a control that shows the rest; after that control, nothing is cut. A pending approval is the
// timeline's first tab stop through a skip link. A streaming message ends its last text line with one terminal cursor,
// CanvasText under forced colors and still under reduced motion, and no fulcrum part animates under reduced motion even
// rendered outside a Timeline, while a host's own data-part widgets keep their motion.
import type { Browser, Page } from "playwright";

// The gallery's streaming messages, paused mid-stream (reduced motion at load), and what each must show. `cursors`: how
// many terminal cursors; `tag`: the element that draws it; `tight`: prose whose last line can be made to fill its
// width exactly, where the cursor must still not take a line of its own; `viewer`: a fence streaming as the code
// viewer, whose head carries the running mark instead; `rail`: the part whose running rail is the live signal, when the
// last block has no text line to end; `open`: a control to click first.
type CursorCase = { id: string; cursors: 0 | 1; tag?: string; tight?: boolean; viewer?: boolean; rail?: string; open?: string; sealed?: true };
const cursorCases: CursorCase[] = [
  { id: "message-streaming", cursors: 1, tight: true },
  { id: "content-streaming", cursors: 1 },
  { id: "message-plain-streaming", cursors: 1, tight: true },
  { id: "markdown-table-streaming", cursors: 1, tag: "td" },
  // Paused after the fence closed: the cursor ends the text after it (checkCursorSteps sees it inside the open fence).
  { id: "markdown-fence-streaming", cursors: 1, tag: "p" },
  // Ends in a closed fence: the cursor stays after its last glyph (md-code-end), on no line of its own.
  { id: "markdown-streaming", cursors: 1, tag: "span" },
  // A notification and an unknown event below the streaming message report on the run: the message keeps the cursor.
  { id: "message-notification-midstream", cursors: 1 },
  // The last block has no text line: it carries the running rail instead.
  { id: "message-block-tail", cursors: 0, rail: "file" },
  { id: "markdown-large-tail", cursors: 0, rail: "md-code-block" },
  { id: "mermaid-tail", cursors: 0, rail: "mermaid" },
  { id: "markdown-crossing", cursors: 0, viewer: true },
  // `sealed`: @fulcrum/ai-sdk commits a message when a new tool row seals it (#112), so the paused frame shows the
  // committed text above the running tool row. checkCursorSteps sees the same message stream with one cursor first.
  { id: "ai-sdk-text-then-tool", cursors: 0, sealed: true },
  { id: "ai-sdk-plain-text-then-tool", cursors: 0, sealed: true },
  // An open reasoning block that streams shows its own state, not a cursor.
  { id: "reasoning-streaming", cursors: 0, open: "[data-part=reasoning] > summary" },
];
type Mode = "normal" | "forced colors" | "reduced motion";
const modes: [Mode, { reducedMotion: "no-preference" | "reduce"; forcedColors: "none" | "active" }][] = [
  ["normal", { reducedMotion: "no-preference", forcedColors: "none" }],
  ["forced colors", { reducedMotion: "no-preference", forcedColors: "active" }],
  ["reduced motion", { reducedMotion: "reduce", forcedColors: "none" }],
];

// Runs in the page, installed as window.liveSignals (installLiveSignals). A message's live signals: its terminal cursors
// (an empty ::after in the flow, or md-code-end's ::before; hidden ones do not count) and its running rails (an empty,
// absolutely placed ::after on a block with no text line to end).
function liveSignals(message: HTMLElement): [HTMLElement[], HTMLElement[]] {
  const empty = (element: HTMLElement, pseudo: string) => getComputedStyle(element, pseudo).content === '""' && element.checkVisibility();
  const all = [message, ...message.querySelectorAll<HTMLElement>("*")];
  const cursors = all.filter((element) => element.dataset.part === "md-code-end" ? empty(element, "::before") : empty(element, "::after") && getComputedStyle(element, "::after").position !== "absolute");
  const rails = all.filter((element) => element.matches("[data-part=mermaid], [data-part=md-code-block], [data-part=source], [data-part=file], [data-part=image], [data-part=block-unknown]") && empty(element, "::after") && getComputedStyle(element, "::after").position === "absolute");
  return [cursors, rails];
}
declare global { interface Window { liveSignals: typeof liveSignals } }
const installLiveSignals = (page: Page) => page.addInitScript(`window.liveSignals = ${liveSignals}`);

// Runs in the page. The streaming message's cursors (the ::after that styles.css draws with an empty content), their
// computed style, the height the cursor adds to the message (a line of its own makes it taller; the commit would take
// it away), and the running mark of a streaming viewer. The ::after shows in the accessibility tree as an unnamed
// generic node with no text: nothing is announced, and it is not a regression.
function readCursor({ id, sealed }: { id: string; sealed?: true }) {
  const message = document.querySelector<HTMLElement>(`#${id} [data-part=message][data-state=${sealed ? "done" : "streaming"}]`);
  if (!message) return undefined;
  const next = message.closest("[data-part=timeline] > *")?.nextElementSibling;
  // The timeline's child is the tool row itself, or a wrapper around it.
  const tool = next?.matches("[data-part=tool]") ? next as HTMLElement : next?.querySelector<HTMLElement>("[data-part=tool]");
  const [holders, rails] = window.liveSignals(message);
  const probe = document.createElement("span");
  probe.style.color = "CanvasText";
  document.body.append(probe);
  const systemColor = getComputedStyle(probe).color;
  probe.style.color = "Highlight";
  const highlightColor = getComputedStyle(probe).color;
  probe.remove();
  // The running tool's rail color: the live rail must speak in the same token.
  const toolRail = document.createElement("div");
  toolRail.dataset.part = "tool";
  toolRail.dataset.state = "streaming";
  message.append(toolRail);
  const runningRail = getComputedStyle(toolRail).borderLeftColor;
  toolRail.remove();
  const height = message.getBoundingClientRect().height;
  const off = document.createElement("style");
  off.textContent = "[data-part=message] *::after, [data-part=message]::after, [data-part=md-code-end]::before { content: none !important; }";
  document.head.append(off);
  const without = message.getBoundingClientRect().height;
  off.remove();
  const mark = message.querySelector("[data-part=md-code-block][data-state=streaming] [data-part=text-viewer-status]");
  const markStyle = mark && getComputedStyle(mark, "::before");
  const look = (style: CSSStyleDeclaration) => ({ background: style.backgroundColor, adjust: style.forcedColorAdjust, animation: style.animationName });
  const box = message.getBoundingClientRect();
  return {
    holders: holders.map((holder) => {
      const style = getComputedStyle(holder, holder.dataset.part === "md-code-end" ? "::before" : "::after");
      return { tag: holder.tagName.toLowerCase(), width: parseFloat(style.width), height: parseFloat(style.height), marginLeft: style.marginLeft, ...look(style) };
    }),
    rails: rails.map((rail) => {
      const style = getComputedStyle(rail, "::after");
      const block = rail.getBoundingClientRect();
      // Its size against its block's, and whether it sits inside the message.
      return { part: rail.dataset.part!, width: parseFloat(style.width), height: parseFloat(style.height), blockHeight: block.height, inside: block.left >= box.left - 0.5, border: getComputedStyle(rail).borderLeftColor, ...look(style) };
    }),
    mark: markStyle && markStyle.content === '""' ? look(markStyle) : undefined,
    systemColor,
    highlightColor,
    runningRail,
    extra: height - without,
    toolAfter: tool?.dataset.state,
  };
}

// Runs in the page. Narrows the message until its last text line, without the cursor, ends less than one cursor width
// from the line's edge, then reports how much height the cursor adds there (a cursor wrapped onto its own line) and how
// much of the cursor shows (nothing may clip it: the message's padding box, the scroller). Then, at the natural width,
// it fills the last line with exactly as many cells as fit (80 at the full measure) and reports the same.
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
  const cursor = getComputedStyle(holder, "::after");
  const width = parseFloat(cursor.width);
  // The cursor starts its gap after the last glyph; every ancestor that clips (overflow, or content-visibility's paint
  // containment) cuts it at its padding box.
  const visible = () => {
    const left = lastGlyph() + parseFloat(cursor.marginLeft);
    let right = left + width;
    for (let node: HTMLElement | null = holder; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.contentVisibility !== "auto") continue;
      right = Math.min(right, node.getBoundingClientRect().left + node.clientLeft + node.clientWidth);
    }
    return Math.max(0, right - left);
  };
  const measure = (slack: number) => {
    document.head.append(off);
    const without = message.getBoundingClientRect().height;
    off.remove();
    return { slack, extra: message.getBoundingClientRect().height - without, visible: visible(), width };
  };
  const start = message.getBoundingClientRect().width;
  let tight: ReturnType<typeof measure> | undefined;
  try {
    for (let next = Math.floor(start); next > start - 400 && !tight; next--) {
      message.style.width = `${next}px`;
      document.head.append(off);
      const slack = edge() - lastGlyph();
      off.remove();
      if (slack >= 0 && slack < advance) tight = measure(slack);
    }
  } finally {
    message.style.width = "";
  }
  const saved = [...holder.childNodes];
  try {
    const probe = document.createElement("span");
    probe.style.whiteSpace = "pre";
    probe.textContent = "x".repeat(100);
    holder.replaceChildren(probe);
    const cell = probe.getBoundingClientRect().width / 100;
    const box = block.getBoundingClientRect();
    const style = getComputedStyle(block);
    const cells = Math.floor((box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)) / cell + 0.001);
    holder.replaceChildren(document.createTextNode("x".repeat(cells)));
    document.head.append(off);
    const slack = edge() - lastGlyph();
    off.remove();
    return { tight, full: { cells, ...measure(slack) } };
  } finally {
    off.remove();
    holder.replaceChildren(...saved);
  }
}

// Runs in the page. The streaming viewer's head says "streaming", and taking that word away (the commit) keeps the head
// one row and moves no other part of it.
function readViewerCommitShift() {
  const head = document.querySelector("#markdown-crossing [data-part=md-code-block][data-state=streaming] [data-part=text-viewer-head]");
  const status = head?.querySelector<HTMLElement>("[data-part=text-viewer-status]");
  if (!head || status?.textContent !== "streaming") return `markdown-crossing: the streaming viewer's head does not say "streaming" (${status?.textContent ?? "no status"})`;
  const parts = [head, ...head.querySelectorAll(":scope > :not([data-part=text-viewer-status]), [data-part=text-viewer-wide]")];
  // The count fills the free space (flex: 1), so only its width may change: its text stays put.
  const rects = () => parts.map((node) => node.getBoundingClientRect()).map(({ x, y, height }) => [x, y, height]);
  const before = rects();
  status.style.display = "none";
  const after = rects();
  status.style.display = "";
  const moved = before.some((rect, i) => rect.some((value, j) => Math.abs(value - after[i]![j]!) > 0.5));
  return moved ? `markdown-crossing: the viewer head moves when its status word goes at the commit (${JSON.stringify(before)} -> ${JSON.stringify(after)})` : undefined;
}

// Runs in the page. A streaming viewer keeps its "streaming" word and its count at every width, as a running tool keeps
// "running".
function readViewerWord() {
  const word = document.querySelector<HTMLElement>("#markdown-crossing [data-part=md-code-block][data-state=streaming] [data-part=text-viewer-status] > span");
  if (!word) return "markdown-crossing: no streaming viewer status word";
  const { width } = word.getBoundingClientRect();
  if (width < 20 || getComputedStyle(word).clipPath !== "none") return `markdown-crossing: the viewer's "streaming" word is hidden (${width.toFixed(1)} px wide)`;
  // Neither the state nor the count is cut, and the head keeps one row.
  const head = word.closest<HTMLElement>("[data-part=text-viewer-head]")!;
  const count = head.querySelector<HTMLElement>("[data-part=text-viewer-count]")!;
  if (count.scrollWidth > count.clientWidth + 0.5) return `markdown-crossing: the viewer's count is cut (${count.clientWidth} of ${count.scrollWidth} px)`;
  // Items centered in one row overlap vertically; a wrapped item starts below another's bottom.
  const boxes = [...head.children].map((child) => child.getBoundingClientRect()).filter((box) => box.width > 1);
  return Math.max(...boxes.map((box) => box.top)) >= Math.min(...boxes.map((box) => box.bottom)) ? "markdown-crossing: the viewer head wraps onto a second row" : undefined;
}

// Runs in the page. Only a text line keeps the cursor's end gutter: a block that never hangs the cursor (code, a table,
// a content row, a rule) reaches the message's edge, where a tool card ends, while paragraphs stop short of it.
function readBlockEdges(id: string) {
  const blocks = "[data-wide], [data-part=md-code-block], [data-part=md-table], [data-part=md-rule], [data-part=reasoning], [data-part=source], [data-part=file], [data-part=image], [data-part=block-unknown]";
  const message = document.querySelector<HTMLElement>(`#${id} [data-part=message]`);
  if (!message) return `${id}: no message`;
  const edge = message.getBoundingClientRect().right;
  const children = [...message.querySelectorAll<HTMLElement>(":scope > *")];
  const wrong = children.flatMap((child) => {
    const gap = edge - child.getBoundingClientRect().right;
    return (child.matches(blocks) ? Math.abs(gap) > 0.5 : gap < 1) ? [`${child.dataset.part ?? child.tagName} ${gap.toFixed(1)} px from the message's edge`] : [];
  });
  if (!children.some((child) => child.matches(blocks))) return `${id}: no block to check (the fixture changed?)`;
  return wrong.length ? `${id} block edges: ${wrong.join("; ")}` : undefined;
}

// Runs in the page. Plain text that ends in a blank line streams without its last line break (content.test.tsx), so
// the cursor sits on the blank line that the commit keeps: the same height streaming and committed.
function readBlankLineCommit() {
  const message = document.querySelector<HTMLElement>("#message-plain-streaming [data-part=message][data-latest]");
  const text = message?.lastElementChild?.firstChild;
  if (!message || !(text instanceof Text)) return "message-plain-streaming: no streaming plain text span";
  const saved = text.data;
  try {
    text.data = "tabbed\tend \n";
    const streaming = message.getBoundingClientRect().height;
    text.data = "tabbed\tend \n\n";
    message.removeAttribute("data-latest");
    message.dataset.state = "done";
    const done = message.getBoundingClientRect().height;
    return Math.abs(done - streaming) > 0.5 ? `message-plain-streaming: text ending in a blank line is ${streaming.toFixed(2)} px streaming and ${done.toFixed(2)} px committed` : undefined;
  } finally {
    text.data = saved;
    message.dataset.state = "streaming";
    message.setAttribute("data-latest", "");
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
  // One live signal: a cursor, or else the rail of the last block.
  const rails = cursor.rails.map(({ part }) => part);
  if (rails.join() !== (demo.rail ?? "")) failures.push(`${at}: running rails on [${rails.join(", ")}], expected [${demo.rail ?? ""}]`);
  for (const rail of cursor.rails) {
    if (rail.width !== 2 || Math.abs(rail.height - rail.blockHeight) > 2.5 || !rail.inside) failures.push(`${at}: the ${rail.part} rail is ${rail.width}x${rail.height} px on a ${rail.blockHeight.toFixed(1)} px block${rail.inside ? "" : ", outside the message"}`);
    // Static and opaque, as a running tool's rail: a pulse would let the block's own border show through it.
    if (rail.animation !== "none") failures.push(`${at}: the ${rail.part} rail animates (${rail.animation}); a running tool's rail is static`);
    if (mode === "forced colors") {
      if (rail.background !== cursor.highlightColor || rail.adjust !== "none") failures.push(`${at}: the ${rail.part} rail is ${rail.background}/${rail.adjust}, expected Highlight ${cursor.highlightColor}/none`);
      if (rail.background === rail.border) failures.push(`${at}: the ${rail.part} rail is the color of its own border (${rail.border}): live looks finished`);
    } else if (rail.background !== cursor.runningRail) failures.push(`${at}: the ${rail.part} rail is ${rail.background}, a running tool's rail is ${cursor.runningRail}`);
  }
  if (demo.sealed && cursor.toolAfter !== "streaming") failures.push(`${at}: the row after the committed message is ${cursor.toolAfter ? `a ${cursor.toolAfter} tool` : "not a tool"}, expected a running tool`);
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
  await installLiveSignals(page);
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
      // A diagram draws at idle time near the viewport.
      if (demo.rail === "mermaid") await page.waitForSelector(`#${demo.id} [data-part=mermaid][data-state=diagram]`, { timeout: 15_000 }).catch(() => failures.push(`${demo.id}: the diagram never drew`));
      await nextFrame(page);
      const cursor = await page.evaluate(readCursor, { id: demo.id, sealed: demo.sealed });
      failures.push(...(cursor ? checkCursorCase(at, mode, demo, cursor) : [`${at}: no ${demo.sealed ? "committed" : "streaming"} message`]));
    }
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const demo of cursorCases.filter(({ tight }) => tight)) {
      await page.locator(`#${demo.id}`).scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await nextFrame(page);
      const fit = await page.evaluate(readTightFit, demo.id);
      if (!fit?.tight) failures.push(`${demo.id} @ ${width}: no width where the last line fills its box (the check found no case)`);
      for (const [name, at] of fit ? [["a tight last line", fit.tight], [`a full ${fit.full.cells}-column line`, fit.full]] as const : []) {
        if (!at) continue;
        const where = `${demo.id} @ ${width}: with ${name} (${at.slack.toFixed(2)} px from its edge)`;
        if (at.extra > 0.5) failures.push(`${where}, the cursor wraps onto its own line (+${at.extra.toFixed(1)} px)`);
        if (at.visible < at.width - 0.01) failures.push(`${where}, ${at.visible.toFixed(2)} of the cursor's ${at.width.toFixed(2)} px show: it is clipped`);
      }
      if (width === 1440 && fit && fit.full.cells !== 80) failures.push(`${demo.id} @ 1440: the measure holds ${fit.full.cells} columns, expected 80`);
    }
    for (const [id, read] of [["markdown-crossing", readViewerCommitShift], ["markdown-crossing", readViewerWord], ["message-plain-streaming", readBlankLineCommit], ["content-done", readBlockEdges], ["markdown-done", readBlockEdges], ["mermaid-mixed", readBlockEdges]] as const) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await nextFrame(page);
      const failure = await page.evaluate(read, id);
      if (failure) failures.push(`${failure} @ ${width}`);
    }
  }
  // The narrowest phone: the viewer head still keeps its state word and its whole count on one row.
  await page.setViewportSize({ width: 320, height: 900 });
  await nextFrame(page);
  const narrow = await page.evaluate(readViewerWord);
  if (narrow) failures.push(`${narrow} @ 320`);
  await page.setViewportSize({ width: 1440, height: 900 });
  if (failures.length === before) console.log(`ok   streaming cursor: ${cursorCases.length} messages show the expected cursor or running mark in normal, forced-colors, and reduced-motion modes; a line that fills its width (80 columns at full width) keeps the whole cursor on it, unclipped, at 1440 and 390; the commit moves nothing`);

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${port}/gallery.html#approval-pending`);
  const approval = await page.waitForSelector("#approval-pending [data-part=approval]");
  const approvalState = await approval.evaluate((element) => ({ borderWidth: getComputedStyle(element).borderLeftWidth, text: element.textContent ?? "" }));
  if (approvalState.borderWidth !== "2px") failures.push(`approval-pending: forced-colors border is ${approvalState.borderWidth}, expected 2px`);
  if (!approvalState.text.trim()) failures.push("approval-pending: status words are not visible in forced colors");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
}

// Runs in the page. Where each demo's first message draws its cursors right now, and how tall its first fence is.
function readCursorStep(ids: string[]) {
  return ids.map((id) => {
    const message = document.querySelector<HTMLElement>(`#${id} [data-part=message]`);
    const holders = message ? window.liveSignals(message)[0] : [];
    const fence = message?.dataset.state === "streaming" ? message.querySelector("pre[data-part=md-code-block]") : null;
    const next = message?.closest("[data-part=timeline] > *")?.nextElementSibling;
    return {
      id,
      fenceHeight: fence ? fence.getBoundingClientRect().height : undefined,
      state: message?.dataset.state,
      later: !!next,
      tool: (next?.matches("[data-part=tool]") ? next as HTMLElement : next?.querySelector<HTMLElement>("[data-part=tool]"))?.dataset.state,
      holders: holders.map((holder) => ({
        tag: holder.tagName.toLowerCase(),
        fence: (() => { const block = holder.closest<HTMLElement>("[data-part=md-code-block]"); return block ? block.dataset.state ?? "done" : null; })(),
        afterFence: holder.previousElementSibling?.matches("[data-part=md-code-block]") ?? false,
      })),
    };
  });
}

// The cursor through every step of live streams, one timer tick at a time on a paused clock: never more than one, after
// the last glyph of the fence while it streams, still there once it closes, then on the text after it, and never on
// text that a later row (a running tool) follows, with markdown and with plain text. A streaming fence never gets
// shorter: the cursor never takes a line of its own that its closing would take away. The ai-sdk demos go through both
// states of #112's rule: the message streams with exactly one cursor before the tool row exists, then commits (no
// cursor) above the running tool.
async function checkCursorSteps(browser: Browser, port: number, failures: string[]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  const start = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1));
  await installLiveSignals(page);
  await page.goto(`http://127.0.0.1:${port}/gallery.html`);
  await page.waitForSelector("#markdown-fence-streaming", { state: "attached", timeout: 10_000 });
  const ids = ["markdown-fence-streaming", "ai-sdk-text-then-tool", "ai-sdk-plain-text-then-tool"];
  const seen = new Set<string>();
  // Each wrong state once, with the first tick and how many ticks showed it.
  const wrong = new Map<string, { first: number; ticks: number }>();
  const flag = (what: string, step: number) => { const at = wrong.get(what); if (at) at.ticks++; else wrong.set(what, { first: step, ticks: 1 }); };
  const before = failures.length;
  const fenceHeights = new Map<string, number>();
  for (let step = 0; step < 200; step++) {
    await page.clock.runFor(30);
    for (const { id, state, later, tool, holders, fenceHeight } of await page.evaluate(readCursorStep, ids)) {
      const prior = fenceHeights.get(id);
      if (prior !== undefined && fenceHeight !== undefined && fenceHeight < prior - 0.5) flag(`${id}: the streaming fence shrinks ${(prior - fenceHeight).toFixed(1)} px`, step);
      if (fenceHeight === undefined) fenceHeights.delete(id);
      else fenceHeights.set(id, fenceHeight);
      if (holders.length > 1) flag(`${id}: ${holders.length} cursors`, step);
      if (id.startsWith("ai-sdk-")) {
        if (!later && state === "streaming") {
          if (holders.length !== 1) flag(`${id}: ${holders.length} cursors on the streaming message before the tool row, expected 1`, step);
          else seen.add(`${id} streaming`);
        }
        // The replay plays one event per tick, so one tick can show the commit before tool_start; a live app gets both
        // from one decode call, in one frame. Once the tool row exists, the message must be committed above it.
        if (later) {
          if (state !== "done" || tool !== "streaming") flag(`${id}: above the tool row the message is ${state} and the tool ${tool}, expected done and streaming`, step);
          else seen.add(`${id} committed`);
        }
      }
      const [holder] = holders;
      if (later) seen.add(`${id} later`);
      if (!holder) continue;
      if (later) flag(`${id}: the cursor stays on text that a later row follows (<${holder.tag}>)`, step);
      seen.add(`${id} ${holder.fence === "streaming" ? "fence" : holder.fence === null ? holder.afterFence ? "after fence" : "text" : "closed fence"}`);
    }
  }
  await page.close();
  for (const [what, { first, ticks }] of wrong) failures.push(`${what}, from tick ${first}, in ${ticks} of 200 ticks`);
  for (const expected of ["markdown-fence-streaming fence", "markdown-fence-streaming closed fence", "markdown-fence-streaming after fence", ...ids.slice(1).flatMap((id) => [`${id} text`, `${id} later`, `${id} streaming`, `${id} committed`])]) {
    if (!seen.has(expected)) failures.push(`cursor steps: never saw "${expected}" (the demo changed?)`);
  }
  if (failures.length === before) console.log(`ok   cursor steps: 200 ticks of ${ids.join(", ")}: one cursor at most, in the open fence, in it once closed, then after it, none on text a running tool follows, and the fence never shrinks; the ai-sdk messages stream with one cursor, then commit above the running tool`);
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
  await checkCursorSteps(browser, port, failures);
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
