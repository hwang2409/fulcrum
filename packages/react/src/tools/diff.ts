export type DiffRow = {
  change: "hunk" | "context" | "delete" | "insert";
  old?: number;
  new?: number;
  text: string;
  /** The changed span [start, end) inside a deleted or inserted line that pairs with one on the other side. */
  word?: [number, number];
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses a unified diff into rows with old and new line numbers. Text before the first hunk is file headers. */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 1;
  let next = 1;
  let inHunk = false;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      rows.push({ change: "hunk", text: line });
    } else if (!inHunk && /^(---|\+\+\+|diff |index )/.test(line)) {
      continue;
    } else if (line.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    } else if (line.startsWith("-")) {
      rows.push({ change: "delete", old: old++, text: line.slice(1) });
    } else if (line.startsWith("+")) {
      rows.push({ change: "insert", new: next++, text: line.slice(1) });
    } else if (line !== "" || inHunk) {
      rows.push({ change: "context", old: old++, new: next++, text: line.slice(1) });
    }
    inHunk ||= line.startsWith("-") || line.startsWith("+") || line.startsWith(" ");
  }
  markWords(rows);
  return rows;
}

// Pairs each run of deletions with the insertions right after it, one to one, and marks what changed between the
// common prefix and suffix. Character-level and linear: cheap enough for every render.
function markWords(rows: DiffRow[]) {
  for (let i = 0; i < rows.length; ) {
    let d = i;
    while (d < rows.length && rows[d]!.change === "delete") d++;
    let n = d;
    while (n < rows.length && rows[n]!.change === "insert") n++;
    if (d - i && d - i === n - d) {
      for (let k = 0; k < d - i; k++) mark(rows[i + k]!, rows[d + k]!);
    }
    i = Math.max(n, i + 1);
  }
}
function mark(a: DiffRow, b: DiffRow) {
  let start = 0;
  while (start < a.text.length && start < b.text.length && a.text[start] === b.text[start]) start++;
  let end = 0;
  while (end < a.text.length - start && end < b.text.length - start && a.text[a.text.length - 1 - end] === b.text[b.text.length - 1 - end]) end++;
  // Marking almost the whole line says nothing the row color does not.
  if (a.text.length - end - start > a.text.length * 0.6 || b.text.length - end - start > b.text.length * 0.6) return;
  a.word = [start, a.text.length - end];
  b.word = [start, b.text.length - end];
}

export function diffStat(rows: DiffRow[]) {
  let insert = 0;
  let remove = 0;
  for (const row of rows) row.change === "insert" ? insert++ : row.change === "delete" ? remove++ : 0;
  return { insert, remove };
}
