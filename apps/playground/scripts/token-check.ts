// Every line of a highlighted box that holds a keyword is colored: a line left plain in a colored block (a cold grammar
// once dropped short lines to plain text) or a block left plain fails. Boxes are the open cards' surfaces that name a
// language: numbered lines, diff and search rows, and highlighted output. A streaming card's newest line may be plain
// for a moment, so streaming cards are skipped.
import type { Page } from "playwright";

function plainLines(final: boolean) {
  const keyword = /\b(import|export|from|const|let|function|return|def|class|interface|async|await)\b/;
  const boxes = [...document.querySelectorAll<HTMLElement>("[data-part=tool-body] [data-language]")];
  const problems: string[] = [];
  for (const box of boxes) {
    if (box.closest("[data-state=streaming]")) continue;
    const rows = box.matches("pre") ? [box] : [...box.querySelectorAll<HTMLElement>("[data-part=line-text], [data-part=diff-text]")];
    // Lines of the box's text, each with whether any of its text sits inside a syntax token.
    const lines: Array<{ text: string; colored: boolean }> = [];
    for (const row of rows) {
      lines.push({ text: "", colored: false });
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const colored = !!node.parentElement!.closest('[class^="tok-"]');
        node.textContent!.split("\n").forEach((part, index) => {
          if (index) lines.push({ text: "", colored: false });
          const line = lines.at(-1)!;
          line.text += part;
          if (colored && part.trim()) line.colored = true;
        });
      }
    }
    const card = box.closest<HTMLElement>("[data-id]")?.dataset.id;
    const plain = lines.map((line, index) => ({ ...line, index })).filter((line) => keyword.test(line.text) && !line.colored);
    if (!plain.length) continue;
    if (!final && !lines.some((line) => line.colored)) problems.push(`${card}: waiting`); // its tokens may still be on the way
    else for (const line of plain) problems.push(`${card} ${box.dataset.part ?? box.tagName.toLowerCase()} (${box.dataset.language}) line ${line.index + 1} is plain: "${line.text.trim().slice(0, 40)}"`);
  }
  return problems;
}

/** Waits up to 10 s for every highlighted box to get its tokens, then names each keyword line still plain. */
export async function checkLineTokens(page: Page): Promise<string[]> {
  for (let waited = 0; waited < 10_000 && (await page.evaluate(plainLines, false)).length; waited += 100) await page.waitForTimeout(100);
  if (!(await page.evaluate(() => document.querySelector("[data-part=tool-body] [data-language]")))) return ["no highlighted box with a language on the page"];
  return page.evaluate(plainLines, true);
}
