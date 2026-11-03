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
  // A pending approval: the timeline's first tab stop is "jump to approval"; drawn on focus without moving a row, and
  // Enter puts focus on the approval's first action, in view.
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
    const before = timeline.getBoundingClientRect().top;
    button.focus();
    const box = button.getBoundingClientRect();
    const shown = getComputedStyle(button).clipPath === "none" && box.width > 40 && box.height >= 24;
    const moved = timeline.getBoundingClientRect().top - before;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const active = document.activeElement as HTMLElement;
    const rect = active.getBoundingClientRect();
    return { first: focusables[0] === button, shown, moved, action: active.dataset.action, inView: rect.top >= 0 && rect.bottom <= innerHeight };
  });
  if (!skip.first) failures.push("approval-pending: jump to approval is not the timeline's first tab stop");
  if (!skip.shown) failures.push("approval-pending: jump to approval is not visible while focused");
  if (skip.moved) failures.push(`approval-pending: focusing jump to approval moved the rows ${skip.moved} px`);
  if (skip.action !== "approve" || !skip.inView) failures.push(`approval-pending: jump focused ${skip.action ?? "nothing"} (${skip.inView ? "in view" : "out of view"}), expected approve in view`);
  if (skip.first && skip.shown && !skip.moved && skip.action === "approve" && skip.inView) console.log("ok   approval-pending: jump to approval is the first tab stop and focuses approve");
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
