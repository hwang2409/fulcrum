// Tool cards in the gallery. A capped box (output, arguments, numbered lines) that cuts its text says so: a fade on
// the cut edge and a control that shows the rest; after that control, nothing is cut. A pending approval is the
// timeline's first tab stop through a skip link.
import type { Browser } from "playwright";

export async function checkCards(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
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
