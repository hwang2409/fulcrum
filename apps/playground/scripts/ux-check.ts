// Strict-UX regressions in the gallery, in real chromium (ux test 6 on 92cf389; ids from its report).
// - viewer (M-B): a streaming fence that became the code viewer follows its newest line to the end, at 1x and 4x CPU:
//   it never says "scrolled" or "new output" while nobody touched it, and its last line ends inside the box; "jump to
//   bottom" on a finished block settles at the bottom and stays "at bottom". An untouched finished block says "at top" (n-6).
// - status words (M-D): every word of every card's status reaches 4.5:1 in all 12 themes, every approval ending on
//   every card state included.
// - viewer head (M-C): at 390 px the head is one row: the count never wraps inside a word and the language label sits
//   in the head, not in a band above it.
// - focus (m-a): approving by keyboard and "show all" leave focus on a control or row in the demo, never on BODY.
// - the gallery: "every state" shows its first sub-agent row (m-e); a disabled steer looks disabled (m-f); a
//   notification row shows its text (m-g); a pending generic approval shows its arguments uncut (m-h); the approval
//   skip link moves no row (n-2); every status reads mark first, then words (n-3); the realistic run's edit was
//   approved (n-4); "empty output" and "huge output" open on the state they describe (n-5); at 390 px the theme
//   select shows its whole value, "5 matches in 3 files" is one line, and sub-agent names keep at least 8 characters
//   (n-7); the side nav's wrapped labels hold their lines together (n-7); Tab reaches a skip-to-content link first (n-9).
import type { Browser, Page } from "playwright";

type Sample = { position: string; gap: number; lastBottom: number; lines: number };

async function sampleCrossing(page: Page): Promise<Sample[]> {
  return page.evaluate(() => new Promise<Sample[]>((resolve) => {
    const root = document.getElementById("markdown-crossing")!;
    const samples: Sample[] = [];
    const started = performance.now();
    const tick = () => {
      const viewer = root.querySelector<HTMLElement>("[data-part=text-viewer]");
      const count = root.querySelector("[data-part=text-viewer-count]")?.textContent ?? "";
      const lines = Number(count.match(/^(\d+) lines?/)?.[1] ?? 0);
      if (viewer) {
        const rows = [...viewer.querySelectorAll<HTMLElement>("[data-part=text-viewer-row]")];
        const box = viewer.getBoundingClientRect();
        const last = Math.max(...rows.map((row) => row.getBoundingClientRect().bottom));
        samples.push({
          position: root.querySelector("[data-part=text-viewer-position]")?.textContent ?? "",
          gap: viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight,
          lastBottom: last - box.bottom,
          lines,
        });
      }
      // The demo appends 60 lines, closes the fence, then restarts after a 1.5 s pause: stop 20 frames after line 60.
      if (samples.filter((sample) => sample.lines >= 60).length >= 20 || performance.now() - started > 15_000) resolve(samples);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

async function checkViewer(browser: Browser, port: number, throttle: number): Promise<string[]> {
  const failures: string[] = [];
  const at = `viewer @ ${throttle}x CPU`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  await page.goto(`http://127.0.0.1:${port}/gallery.html#markdown-crossing`);
  await page.waitForSelector("#markdown-crossing [data-part=text-viewer]", { timeout: 30_000 });
  const samples = await sampleCrossing(page);
  const streaming = samples.filter((sample) => sample.lines < 60);
  const lost = streaming.filter((sample) => sample.position !== "at bottom");
  if (!streaming.length) failures.push(`${at}: markdown-crossing never streamed into the viewer`);
  if (lost.length) failures.push(`${at}: markdown-crossing says "${lost[0]!.position}" on ${lost.length} of ${streaming.length} streaming frames (gap ${lost[0]!.gap.toFixed(1)} px); nobody scrolled`);
  const end = samples.at(-1);
  // Under 1 px is chromium rounding the scroll extent of a fractional (40lh) box to whole pixels.
  if (!end || end.gap >= 1 || end.lastBottom >= 1 || end.position !== "at bottom")
    failures.push(`${at}: the streamed block ends ${end?.gap.toFixed(1)} px short of its bottom, last line ${end?.lastBottom.toFixed(1)} px past the box, "${end?.position}"`);
  if (!failures.length) console.log(`ok   ${at}: markdown-crossing stays "at bottom" on ${streaming.length} streaming frames and ends on its last line`);

  await page.goto(`http://127.0.0.1:${port}/gallery.html#markdown-large`);
  await page.waitForSelector("#markdown-large [data-part=text-viewer-row]");
  await page.waitForTimeout(500 * throttle);
  const untouched = await page.textContent("#markdown-large [data-part=text-viewer-position]");
  if (untouched !== "at top") failures.push(`${at}: an untouched finished block says "${untouched}", expected "at top"`);
  await page.click("#markdown-large [data-action=jump-bottom]");
  const settled: { gap: number; position: string }[] = [];
  for (const wait of [50, 250, 500]) {
    await page.waitForTimeout(wait);
    settled.push(await page.evaluate(() => {
      const viewer = document.querySelector<HTMLElement>("#markdown-large [data-part=text-viewer]")!;
      return { gap: viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight, position: document.querySelector("#markdown-large [data-part=text-viewer-position]")!.textContent! };
    }));
  }
  const off = settled.find((sample) => sample.gap >= 1 || sample.position !== "at bottom");
  if (off) failures.push(`${at}: "jump to bottom" settles ${off.gap.toFixed(1)} px short and says "${off.position}"`);
  else console.log(`ok   ${at}: an untouched block says "at top"; jump to bottom settles at the bottom`);
  await page.close();
  return failures;
}

async function checkNarrowHead(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${port}/gallery.html#markdown-large`);
  await page.waitForSelector("#markdown-large [data-part=text-viewer-row]");
  for (const id of ["markdown-large", "markdown-large-constructs"]) {
    const heads = await page.evaluate((id) => [...document.querySelectorAll<HTMLElement>(`#${id} [data-part=md-code-block][data-size=large]`)].map((block) => {
      const head = block.querySelector<HTMLElement>("[data-part=text-viewer-head]")!;
      const count = head.querySelector<HTMLElement>("[data-part=text-viewer-count]")!;
      const line = parseFloat(getComputedStyle(count).lineHeight) || 18;
      const range = document.createRange();
      range.selectNodeContents(count);
      const lines = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size;
      return {
        head: Math.round(head.getBoundingClientRect().height),
        above: Math.round(head.getBoundingClientRect().top - block.getBoundingClientRect().top),
        lines,
        countHeight: count.getBoundingClientRect().height,
        line,
        label: head.textContent ?? "",
        language: block.dataset.language,
      };
    }), id);
    for (const [index, head] of heads.entries()) {
      const name = `head @ 390: ${id} block ${index + 1}`;
      if (head.lines > 1 || head.countHeight > head.line * 1.5) failures.push(`${name}: the count wraps over ${head.lines} lines (${Math.round(head.countHeight)} px): "${head.label}"`);
      if (head.head > 48) failures.push(`${name}: the head is ${head.head} px tall, more than one row`);
      if (head.above > 2) failures.push(`${name}: ${head.above} px above the head (the language label is a band of its own)`);
      if (head.language && !head.label.includes(head.language)) failures.push(`${name}: the head does not name its language ${head.language}`);
    }
  }
  if (!failures.length) console.log("ok   head @ 390: every large block's head is one row with its language and an unbroken count");
  await page.close();
  return failures;
}

async function checkFocus(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const where = () => page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return { tag: active?.tagName ?? "none", demo: active?.closest("article.demo")?.id ?? "", part: active?.dataset.part ?? active?.closest<HTMLElement>("[data-part]")?.dataset.part ?? "" };
  });
  await page.goto(`http://127.0.0.1:${port}/gallery.html#approval-pending`);
  await page.focus("#approval-pending [data-action=approve]");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const approved = await where();
  if (approved.tag === "BODY" || approved.demo !== "approval-pending") failures.push(`focus: after approve by keyboard, focus is on ${approved.tag} in "${approved.demo}", expected the resolved row`);
  await page.goto(`http://127.0.0.1:${port}/gallery.html#tools-done`);
  await page.waitForSelector("#tools-done [data-action=expand]");
  await page.focus("#tools-done [data-action=expand]");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const shown = await where();
  if (shown.tag === "BODY" || shown.demo !== "tools-done") failures.push(`focus: after "show all", focus is on ${shown.tag} in "${shown.demo}", expected the shown output`);
  await page.goto(`http://127.0.0.1:${port}/gallery.html#tool-huge`);
  await page.waitForSelector("#tool-huge details[data-part=tool]");
  await page.evaluate(() => { document.querySelector<HTMLDetailsElement>("#tool-huge details[data-part=tool]")!.open = true; }); // n-5 is checked on its own
  await page.waitForSelector("#tool-huge [data-action=open-viewer]");
  await page.focus("#tool-huge [data-action=open-viewer]");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const opened = await where();
  if (opened.tag === "BODY" || opened.demo !== "tool-huge") failures.push(`focus: after "open all", focus is on ${opened.tag} in "${opened.demo}", expected the viewer (tool-huge)`);
  if (!failures.length) console.log(`ok   focus: approve (${approved.part}), show all (${shown.part}), and open all (${opened.part}) keep focus in their card`);
  await page.close();
  return failures;
}

async function checkGallery(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${port}/gallery.html`);
  await page.waitForSelector("#subagent-states [data-part=sub-agent]");
  await page.waitForTimeout(300);
  // n-9: the first tab stop skips the nav.
  await page.keyboard.press("Tab");
  const skip = await page.evaluate(() => {
    const active = document.activeElement as HTMLAnchorElement;
    return { text: active.textContent?.trim(), href: active.getAttribute("href"), visible: active.getBoundingClientRect().width > 0 && getComputedStyle(active).clipPath === "none" };
  });
  if (!/skip to content/i.test(skip.text ?? "") || !skip.href?.startsWith("#") || !skip.visible) failures.push(`gallery: the first tab stop is "${skip.text}" (${skip.href}), expected a visible "skip to content" link`);
  else {
    await page.keyboard.press("Enter");
    const landed = await page.evaluate(() => document.activeElement?.closest("main") !== null && document.activeElement !== document.body);
    if (!landed) failures.push("gallery: skip to content does not move focus into the main column");
  }
  const facts = await page.evaluate(() => {
    const text = (selector: string) => document.querySelector(selector)?.textContent ?? "";
    // m-e: the first row of "every state" is in view.
    const scroll = document.querySelector<HTMLElement>("#subagent-states [data-part=timeline-scroll]")!;
    const first = scroll.querySelector<HTMLElement>("[data-part=sub-agent]")!;
    const firstHidden = Math.round(scroll.getBoundingClientRect().top - first.getBoundingClientRect().top);
    // m-f: a disabled steer looks like the disabled send.
    const steer = document.querySelector<HTMLElement>('#composer-stopping [data-action=steer][aria-disabled="true"]');
    const send = document.querySelector<HTMLElement>('#composer-idle [data-action=send][aria-disabled="true"]');
    const look = (node: HTMLElement | null) => node ? `${getComputedStyle(node).color} on ${getComputedStyle(node).backgroundColor}` : "missing";
    // n-3: the mark comes first in every status: no word sits left of the mark.
    const misordered = [...document.querySelectorAll<HTMLElement>("[data-part=tool-status]")].filter((status) => {
      const words = [...status.children].filter((child) => child.textContent?.trim()) as HTMLElement[];
      const markLeft = status.getBoundingClientRect().left;
      return words.some((word) => word.getBoundingClientRect().left < markLeft + 7);
    }).map((status) => status.textContent);
    // n-5: the demos that describe a body open on it.
    const closed = ["tool-empty", "tool-huge"].filter((id) => [...document.querySelectorAll<HTMLDetailsElement>(`#${id} details[data-part=tool]`)].some((card) => !card.open));
    return {
      firstHidden,
      steer: look(steer),
      send: look(send),
      notification: text("#fallback-notification [data-part=item]"),
      genericCut: text("#approval-generic [data-part=tool-gap]"),
      genericViewer: !!document.querySelector("#approval-generic [data-part=text-viewer]"),
      misordered,
      edit: text('#timeline-run [data-tool-view="edit"] [data-part=tool-approval], #timeline-run [data-tool="edit"] [data-part=tool-approval]'),
      closed,
    };
  });
  if (facts.firstHidden > 0) failures.push(`gallery: "every state" hides ${facts.firstHidden} px of its first row`);
  if (facts.steer !== facts.send) failures.push(`gallery: a disabled steer is ${facts.steer}, a disabled send is ${facts.send}`);
  if (!facts.notification.includes("Context compacted")) failures.push(`gallery: the notification row says "${facts.notification}", expected its text`);
  if (facts.genericCut || !facts.genericViewer) failures.push(`gallery: the pending generic approval cuts its arguments ("${facts.genericCut}")`);
  if (facts.misordered.length) failures.push(`gallery: ${facts.misordered.length} statuses put a word before the mark: ${[...new Set(facts.misordered)].slice(0, 3).join(" | ")}`);
  if (facts.edit !== "approved") failures.push(`gallery: the realistic run's edit says "${facts.edit}", expected "approved"`);
  if (facts.closed.length) failures.push(`gallery: ${facts.closed.join(", ")} open collapsed; they describe their body`);
  // n-2: focusing the skip link moves no row.
  await page.evaluate(() => document.getElementById("approval-pending")!.scrollIntoView());
  const shift = await page.evaluate(() => {
    const timeline = document.querySelector<HTMLElement>("#approval-pending [data-part=timeline]")!;
    const row = timeline.querySelector<HTMLElement>(":scope > :not([data-part=jump-to-approval])")!;
    const before = row.getBoundingClientRect().top;
    timeline.querySelector<HTMLElement>("[data-part=jump-to-approval]")!.focus({ preventScroll: true });
    const after = row.getBoundingClientRect().top;
    return Math.round(after - before);
  });
  if (shift) failures.push(`gallery: focusing "jump to approval" moves the timeline ${shift} px; it must overlay`);
  // n-7: the side nav's wrapped labels: their lines sit closer to each other than to the next label.
  await page.setViewportSize({ width: 1024, height: 900 });
  const loose = await page.evaluate(() => {
    const out: string[] = [];
    const links = [...document.querySelectorAll<HTMLElement>(".nav-group a")];
    links.forEach((link, index) => {
      const range = document.createRange();
      range.selectNodeContents(link);
      const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const tops = [...new Set(lines.map((rect) => Math.round(rect.top)))];
      if (tops.length < 2) return;
      const next = links[index + 1];
      if (!next || next.parentElement !== link.parentElement) return;
      const nextRange = document.createRange();
      nextRange.selectNodeContents(next);
      const nextTop = Math.min(...[...nextRange.getClientRects()].map((rect) => rect.top));
      const bottom = Math.max(...lines.map((rect) => rect.bottom));
      const within = tops[1]! - Math.min(...lines.map((rect) => rect.bottom));
      if (nextTop - bottom <= within + 2) out.push(`${link.textContent} (${Math.round(within)} px between its lines, ${Math.round(nextTop - bottom)} px to the next)`);
    });
    return out;
  });
  if (loose.length) failures.push(`gallery @ 1024: ${loose.length} wrapped nav labels sit as close to the next label as to their own line: ${loose[0]}`);
  // n-7 at 390 px.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const narrow = await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>("#theme")!;
    select.value = "auto";
    const canvas = new OffscreenCanvas(1, 1).getContext("2d")!;
    const style = getComputedStyle(select);
    canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const label = select.selectedOptions[0]!.textContent!;
    const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 20; // the arrow
    const meta = [...document.querySelectorAll<HTMLElement>("#timeline-run [data-part=tool-meta] > *")].filter((node) => /matches in/.test(node.textContent ?? ""));
    const wrappedMeta = meta.filter((node) => node.getBoundingClientRect().height > parseFloat(getComputedStyle(node).lineHeight) * 1.5).map((node) => node.textContent);
    const names = [...document.querySelectorAll<HTMLElement>("#subagent-states [data-part=sub-agent-name]")].map((node) => {
      const ch = parseFloat(getComputedStyle(node).fontSize) * 0.6;
      return { name: node.textContent!, shown: Math.floor(node.clientWidth / ch), full: node.scrollWidth <= node.clientWidth + 1 };
    }).filter((entry) => !entry.full && entry.shown < Math.min(8, entry.name.length));
    return { label, fits: canvas.measureText(label).width <= room, wrappedMeta, names };
  });
  if (!narrow.fits) failures.push(`gallery @ 390: the theme select cuts "${narrow.label}"`);
  if (narrow.wrappedMeta.length) failures.push(`gallery @ 390: "${narrow.wrappedMeta[0]}" wraps`);
  if (narrow.names.length) failures.push(`gallery @ 390: sub-agent names cut to ${narrow.names.map((entry) => `${entry.name}:${entry.shown}`).join(", ")} characters`);
  if (!failures.length) console.log("ok   gallery: skip link, every-state rows, disabled steer, notification text, uncut generic approval, overlay skip link, mark order, approved edit, open demos, nav labels, 390 px fits");
  await page.close();
  return failures;
}

// M-D: every word in every card's status (the state, a folded approval's decision, the duration), in every theme, at
// 4.5:1 on the background it is drawn on, with the approval-endings demo's every ending on every card state present.
async function checkStatusWords(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${port}/gallery.html`);
  await page.waitForSelector("#approval-endings [data-part=tool]", { timeout: 10_000 }).catch(() => failures.push("status words: no approval-endings demo on the gallery"));
  const themes = await page.$$eval("#theme option", (options) => options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== "auto"));
  let checked = 0;
  for (const theme of themes) {
    await page.selectOption("#theme", theme);
    await page.waitForTimeout(50);
    const result = await page.evaluate(() => {
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
      const backgroundOf = (start: HTMLElement | null) => {
        const layers: number[][] = [];
        for (let node = start; node; node = node.parentElement) if (layers.at(-1)?.[3] !== 1) layers.push(rgba(getComputedStyle(node).backgroundColor));
        return layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]);
      };
      const contrast = (node: HTMLElement) => {
        const background = backgroundOf(node);
        const [light, dark] = [luminance(over(rgba(getComputedStyle(node).color), background)), luminance(background)].sort((a, b) => b - a);
        return (light! + 0.05) / (dark! + 0.05);
      };
      const problems: string[] = [];
      let words = 0;
      for (const status of document.querySelectorAll<HTMLElement>("[data-part=tool-status]")) {
        const card = status.closest<HTMLElement>("[data-state]")!;
        // Each run of text in the status is drawn by its own parent: the status itself or a word span inside it.
        const walker = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          if (!text.textContent?.trim()) continue;
          const node = text.parentElement!;
          if (node.closest("[aria-hidden=true]") && node !== status) continue;
          words++;
          const ratio = contrast(node);
          if (ratio < 4.5) problems.push(`${card.dataset.part} ${card.dataset.state}${card.dataset.decision ? `/${card.dataset.decision}` : ""} "${text.textContent.trim()}" (${node.dataset.part ?? "tool-status"}${node.dataset.decision ? ` ${node.dataset.decision}` : ""}) is ${ratio.toFixed(2)}:1`);
        }
      }
      const endings = new Set([...document.querySelectorAll<HTMLElement>("#approval-endings [data-part=tool]")].map((card) => `${card.dataset.state}:${card.querySelector<HTMLElement>("[data-part=tool-approval]")?.textContent}`));
      return { problems, words, endings: [...endings] };
    });
    checked += result.words;
    for (const problem of [...new Set(result.problems)]) failures.push(`status words @ ${theme}: ${problem}, needs 4.5:1`);
    if (theme === themes[0] && result.endings.length < 20) failures.push(`status words: approval-endings shows ${result.endings.length} of 20 ending/state pairs (${result.endings.join(", ")})`);
  }
  if (!failures.length) console.log(`ok   status words: ${checked} words over ${themes.length} themes, every one 4.5:1`);
  await page.close();
  return failures;
}

const checks = { viewer1: (b: Browser, p: number) => checkViewer(b, p, 1), viewer4: (b: Browser, p: number) => checkViewer(b, p, 4), head: checkNarrowHead, focus: checkFocus, gallery: checkGallery, status: checkStatusWords };

/** ONLY=focus,gallery runs some of the checks. */
export async function checkUx(browser: Browser, port: number): Promise<string[]> {
  const only = process.env.ONLY?.split(",");
  const failures: string[] = [];
  for (const [name, check] of Object.entries(checks)) {
    if (only && !only.includes(name)) continue;
    try { failures.push(...await check(browser, port)); }
    catch (error) { failures.push(`${name}: ${String(error).split("\n")[0]}`); }
  }
  return failures;
}

if (import.meta.main) {
  const { chromium } = await import("playwright");
  const port = Number(process.env.PORT ?? 5173);
  const browser = await chromium.launch();
  const failures = await checkUx(browser, port).finally(() => browser.close());
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(failures.length ? 1 : 0);
}
