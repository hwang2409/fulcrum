// Every highlighted box on the gallery is colored line by line, against a fixture: the lines each box keeps plain on
// purpose, by card and surface. Every other line with text must hold a syntax token, so a line left plain in a colored
// block (a cold grammar once dropped a read's first line) fails, and so does a box left plain. A box without a fixture
// fails, and so does a fixture whose box is gone. Collapsed cards are opened for the check. A streaming card's newest
// line may be plain for a moment, so streaming boxes are skipped.
import type { Page } from "playwright";

const gap = 41; // the "… N lines / N characters; open to view all …" line of a cut preview
// Line numbers are 1-based. Each plain line says why it stays plain. A diff's hunk headers (`@@ … @@`) are muted by
// their row, not tokens.
const expectedPlain: Record<string, number[]> = {
  "tool:run-config tool-lines": [],
  "tool:run-edit tool-diff": [1],
  "tool:done-read tool-lines": [],
  "tool:done-read-py tool-lines": [],
  "tool:nav-read tool-lines": [], // the sub-agent demo's parent run
  "tool:done-edit tool-diff": [1],
  "tool:ap-edit tool-diff": [1], // the resolved approval, folded into its tool card
  "tool:done-write tool-lines": [],
  "tool:done-fetch tool-output": [],
  "tool:done-fetch-html tool-output": [],
  "tool:done-todo tool-output": [],
  "tool:error-edit tool-diff": [1],
  "tool:error-write tool-lines": [],
  "tool:error-fetch tool-output": [],
  "tool:canceled-edit tool-diff": [1],
  "tool:canceled-write tool-lines": [],
  "tool:diff tool-diff": [1, 7],
  "tool:lang-0 tool-lines": [], // rust
  "tool:lang-1 tool-lines": [], // go
  "tool:lang-2 tool-lines": [4], // sql: the grammar gives `);` no scope
  "tool:lang-3 tool-lines": [], // dockerfile
  "tool:lang-4 tool-lines": [], // shell
  "approval:r-edit-pending tool-diff": [1],
  "approval:r-write tool-lines": [],
  // The preview's tail is highlighted without the text above it, so json closers outside their object are plain.
  "approval:r-generic tool-args": [gap, 50, 61, 62],
};

type Run = [text: string, colored: boolean];
type Box = { key: string; streaming: boolean; rows: Run[][] };
type Line = { text: string; colored: boolean };

// In the page: each box's rows as runs of text, each run inside a syntax token or not.
function readBoxes(): Box[] {
  return [...document.querySelectorAll<HTMLElement>("[data-part=tool-body] [data-language]")].map((box) => {
    const rows = box.matches("pre") ? [box] : [...box.querySelectorAll<HTMLElement>("[data-part=line-text], [data-part=diff-text]")];
    return {
      key: `${box.closest<HTMLElement>("[data-id]")?.dataset.id} ${box.dataset.part ?? "pre"}`,
      streaming: !!box.closest("[data-state=streaming]"),
      rows: rows.map((row) => {
        const runs: Run[] = [];
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) runs.push([node.textContent!, !!node.parentElement!.closest('[class^="tok-"]')]);
        return runs;
      }),
    };
  });
}

// A box's lines: each row starts one, and a newline inside a run starts the next.
function boxLines(rows: Run[][]): Line[] {
  const lines: Line[] = [];
  for (const runs of rows) {
    lines.push({ text: "", colored: false });
    for (const [text, colored] of runs) {
      text.split("\n").forEach((part, index) => {
        if (index) lines.push({ text: "", colored: false });
        const line = lines.at(-1)!;
        line.text += part;
        line.colored ||= colored && part.trim() !== "";
      });
    }
  }
  return lines;
}

function boxProblems(box: Box): string[] {
  const plain = expectedPlain[box.key];
  if (!plain) return [`${box.key}: highlighted box has no fixture in token-check.ts`];
  return boxLines(box.rows).flatMap((line, index) => {
    const expected = plain.includes(index + 1) ? "plain" : line.text.trim() ? "colored" : "blank";
    const actual = line.colored ? "colored" : line.text.trim() ? "plain" : "blank";
    return expected === actual || expected === "blank" ? [] : [`${box.key} line ${index + 1} is ${actual}, expected ${expected}: "${line.text.trim().slice(0, 40)}"`];
  });
}

function problems(boxes: Box[]): string[] {
  const settled = boxes.filter((box) => !box.streaming);
  const found = new Set(settled.map((box) => box.key));
  const missing = Object.keys(expectedPlain).filter((key) => !found.has(key)).map((key) => `${key}: fixture names a box that is not on the page`);
  return [...missing, ...settled.flatMap(boxProblems)];
}

/** Opens the collapsed cards, waits up to 10 s for every box to match its fixture, names each line that does not, and closes them again. */
export async function checkLineTokens(page: Page): Promise<string[]> {
  const opened = await page.evaluate(() => [...document.querySelectorAll<HTMLDetailsElement>("details[data-id]:not([open])")].map((card) => { card.open = true; return card.dataset.id!; }));
  let found = problems(await page.evaluate(readBoxes));
  for (let waited = 0; waited < 10_000 && found.length; waited += 100) {
    await page.waitForTimeout(100);
    found = problems(await page.evaluate(readBoxes));
  }
  await page.evaluate((ids) => { for (const id of ids) document.querySelector<HTMLDetailsElement>(`details[data-id="${id}"]`)!.open = false; }, opened);
  return found;
}
