// Streaming demos in the gallery, with motion on so they loop. "shell, streaming" restarts into the same tool id on
// every loop: across three loops it must show its 24 lines once each and log no console error (React's duplicate-key
// errors were the symptom of a replayed output corrupting its ANSI cache). "markdown and code, streaming" only appends:
// sampled on every frame, a message's text must never shrink except when the loop restarts the store.
import type { Browser } from "playwright";

export async function checkStreams(browser: Browser, port: number): Promise<string[]> {
  const failures: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 160)); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const target = window as typeof window & { __drops: string[]; __loops: number[] };
    target.__drops = [];
    target.__loops = [];
    let last = 0;
    let lines = 0;
    const tick = () => {
      const message = document.querySelector<HTMLElement>("#markdown-streaming [data-part=message]");
      const length = message?.innerText.length ?? 0;
      // A loop restart empties the store: the text drops to a small fraction. Any other drop is lost text.
      if (length < last && length >= last * 0.3) target.__drops.push(`${last} -> ${length}: ${JSON.stringify(message!.innerText.slice(-60))}`);
      last = length;
      const output = document.querySelector<HTMLElement>("#tool-running [data-part=tool-output]");
      const count = output?.textContent?.split("\n").filter(Boolean).length ?? 0;
      if (count < lines && lines) target.__loops.push(lines); // the loop restarted: record the finished loop's line count
      lines = count;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(`http://127.0.0.1:${port}/gallery.html`);
  // Both demos stream only while they are on screen: keep them in view, one at a time.
  for (const id of ["tool-running", "markdown-streaming"]) {
    await page.evaluate((id) => document.getElementById(id)!.scrollIntoView({ block: "center" }), id);
    if (id === "tool-running") {
      await page.waitForFunction(() => (window as typeof window & { __loops: number[] }).__loops.length >= 3, undefined, { timeout: 60_000 }).catch(() => {});
      const loops = await page.evaluate(() => (window as typeof window & { __loops: number[] }).__loops);
      if (loops.length < 3 || loops.slice(0, 3).some((count) => count !== 24)) failures.push(`shell, streaming: loops ended with [${loops.join(", ")}] output lines, expected 24 three times`);
      else console.log(`ok   shell, streaming: 3 loops of 24 lines`);
    } else {
      await page.waitForTimeout(15_000);
      const drops = await page.evaluate(() => (window as typeof window & { __drops: string[] }).__drops);
      for (const drop of drops) failures.push(`markdown, streaming: text shrank ${drop}`);
      if (!drops.length) console.log("ok   markdown, streaming: text never shrank over 15 s");
    }
  }
  for (const error of [...new Set(errors)]) failures.push(`streaming demos: console error ${error}`);
  await page.close();
  return failures;
}

if (import.meta.main) {
  const { chromium } = await import("playwright");
  const port = Number(process.env.PORT ?? 5173);
  const browser = await chromium.launch();
  const failures = await checkStreams(browser, port).finally(() => browser.close());
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(failures.length ? 1 : 0);
}
