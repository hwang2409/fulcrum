// Composer, in the gallery's composer demos, at 390, 768, 1024, and 1440 px. Every state is on the page. The field
// grows with its draft up to ten lines and then scrolls; an error or a pending action never changes the composer's
// height; buttons are at least 36 px tall (44 px under 860 px) and keep their width when "stop" becomes "stopping".
// In the live demo, Enter sends and the field keeps focus, the action turns to steer while the turn runs, a refused
// steer keeps the draft and shows a polite error, and stop goes through its pending state back to idle.
import type { Browser } from "playwright";

const STATES = ["live", "idle", "draft", "grow", "sending", "send-error", "steerable", "steering", "running", "stopping", "stop-error", "read-only"];

export async function checkComposer(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  // The frozen demos reach their states on mount; that must neither scroll the page nor take focus.
  const top = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await top.goto(`http://127.0.0.1:${port}/gallery.html`);
  await top.waitForSelector('#composer-stop-error [data-part="composer"][data-error="stop"]');
  await top.waitForTimeout(300);
  const opened = await top.evaluate(() => ({ y: scrollY, active: document.activeElement?.tagName }));
  if (opened.y !== 0 || opened.active !== "BODY") failures.push(`composer: /gallery.html opens at scrollY ${opened.y} with focus on ${opened.active}; it must open at the top with nothing focused`);
  // A run path deep link has no #id; it still lands on its demo.
  await top.goto(`http://127.0.0.1:${port}/gallery.html?run-navigator-nested=reviewer&run-navigator-nested=tester`);
  await top.waitForSelector('#composer-stop-error [data-part="composer"][data-error="stop"]');
  await top.waitForTimeout(300);
  const nested = await top.evaluate(() => document.getElementById("run-navigator-nested")!.getBoundingClientRect().top);
  if (nested < -1 || nested > 200) failures.push(`composer: the nested run-navigator deep link lands with its demo at top ${Math.round(nested)} px`);
  await top.close();
  for (const width of [390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const at = `composer @ ${width}`;
    await page.goto(`http://127.0.0.1:${port}/gallery.html#composer-live`);
    await page.waitForSelector('#composer-stop-error [data-part="composer"][data-error="stop"]');
    const measured = await page.evaluate((states) => {
      const box = (id: string) => document.querySelector<HTMLElement>(`#composer-${id} [data-part="composer"]`);
      const field = (id: string) => box(id)?.querySelector("textarea") ?? null;
      const height = (id: string) => box(id)?.getBoundingClientRect().height ?? -1;
      const grow = field("grow")!;
      const stop = box("stopping")!.querySelector<HTMLElement>('[data-part="composer-stop"]')!;
      const idleStop = box("steerable")!.querySelector<HTMLElement>('[data-part="composer-stop"]')!;
      const buttons = [...document.querySelectorAll<HTMLElement>('[data-part="composer"] button')].map((button) => ({ name: button.getAttribute("aria-label"), height: button.getBoundingClientRect().height }));
      return {
        missing: states.filter((id) => !box(id)),
        grow: { client: grow.clientHeight, scroll: grow.scrollHeight, max: parseFloat(getComputedStyle(grow).maxHeight), line: parseFloat(getComputedStyle(grow).lineHeight) },
        draft: { client: field("draft")!.clientHeight, scroll: field("draft")!.scrollHeight },
        idle: field("idle")!.clientHeight,
        heights: Object.fromEntries(["sending", "send-error", "steerable", "steering", "stopping", "stop-error", "running"].map((id) => [id, height(id)])),
        stopWidths: [idleStop.getBoundingClientRect().width, stop.getBoundingClientRect().width],
        buttons,
        readOnly: { controls: box("read-only")!.querySelectorAll("button, textarea").length, reason: box("read-only")!.textContent },
      };
    }, STATES);
    const problems: string[] = [];
    if (measured.missing.length) problems.push(`missing states: ${measured.missing.join(", ")}`);
    const { grow, draft, idle, heights } = measured;
    // The cap is ten whole lines and the top padding: the cut edge falls between lines.
    const lines = (grow.client - 10) / grow.line;
    if (Math.abs(lines - 10) > 0.05) problems.push(`long draft shows ${lines.toFixed(2)} lines at the cap, needs 10 whole lines`);
    if (Math.abs(grow.client - grow.max) > 1 || grow.scroll <= grow.client + 10) problems.push(`long draft: ${grow.client} px tall of ${grow.max} max, scrollHeight ${grow.scroll}; it must stop at the cap and scroll`);
    if (draft.client <= idle || draft.scroll > draft.client + 1) problems.push(`two-line draft: ${draft.client} px (idle ${idle}), scrollHeight ${draft.scroll}; it must grow to fit`);
    if (heights.sending !== heights["send-error"]) problems.push(`error moves the layout: sending ${heights.sending} px, send failed ${heights["send-error"]} px`);
    for (const id of ["steering", "stopping", "stop-error"]) if (heights[id] !== heights.steerable) problems.push(`${id} is ${heights[id]} px, steer is ${heights.steerable} px`);
    if (measured.stopWidths[0] !== measured.stopWidths[1]) problems.push(`stop changes width when pending: ${measured.stopWidths.join(" -> ")}`);
    const floor = width <= 860 ? 44 : 36;
    for (const button of measured.buttons) if (button.height < floor - 0.5) problems.push(`"${button.name}" is ${Math.round(button.height)} px tall, needs ${floor}`);
    if (measured.readOnly.controls || !measured.readOnly.reason?.trim()) problems.push(`read-only shows ${measured.readOnly.controls} controls and reason "${measured.readOnly.reason}"`);

    // The live flow: send, steer while running, a refused steer, stop.
    const live = page.locator('#composer-live [data-part="composer"]');
    const field = live.locator("textarea");
    const submit = live.locator('[data-part="composer-submit"]');
    try {
      await field.click();
      await field.fill("first message");
      const before = (await live.boundingBox())!.height;
      await page.keyboard.press("Enter");
      if (!(await field.evaluate((node) => document.activeElement === node))) problems.push("focus left the field after Enter");
      await page.locator('#composer-live [data-part="composer"][data-pending="submit"]').waitFor({ timeout: 1000 });
      await page.locator('#composer-live [data-part="composer"][data-state="steerable"]').waitFor({ timeout: 3000 });
      if ((await field.inputValue()) !== "") problems.push(`draft not cleared after send: "${await field.inputValue()}"`);
      if ((await submit.textContent()) !== "steer") problems.push(`action reads "${await submit.textContent()}" while the turn runs`);
      await field.fill("fail");
      await page.keyboard.press("Enter");
      await page.locator('#composer-live [data-part="composer"][data-error="submit"]').waitFor({ timeout: 3000 });
      const message = await live.locator('[role="status"]').textContent();
      if (!message?.startsWith("could not steer:")) problems.push(`refused steer says "${message}"`);
      if ((await field.inputValue()) !== "fail") problems.push("refused steer lost the draft");
      const after = (await live.boundingBox())!.height;
      if (after !== before) problems.push(`the error moved the layout: ${before} -> ${after} px`);
      if (!(await field.evaluate((node) => document.activeElement === node))) problems.push("focus left the field after a refused steer");
      await field.fill("also check the windows path");
      await submit.click();
      if (!(await field.evaluate((node) => document.activeElement === node))) problems.push("focus left the field after a click on steer");
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#composer-live textarea")?.value === "", undefined, { timeout: 3000 });
      await live.locator('[data-part="composer-stop"]').click();
      await live.locator('[data-part="composer-stop"]', { hasText: "stopping" }).waitFor({ timeout: 1000 });
      await page.locator('#composer-live [data-part="composer"][data-state="idle"]').waitFor({ timeout: 3000 });
      if (await live.locator('[data-part="composer-stop"]').count()) problems.push("stop still shown after the turn ended");
    } catch (error) {
      problems.push(`live flow: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
    if (errors.length) problems.push(`page errors: ${errors.join("; ")}`);
    for (const problem of problems) failures.push(`${at}: ${problem}`);
    if (!problems.length) console.log(`ok   ${at}: ${STATES.length} states, grows to ${grow.max} px then scrolls, no shift, live send/steer/stop`);
    await page.close();
  }
  return failures;
}
