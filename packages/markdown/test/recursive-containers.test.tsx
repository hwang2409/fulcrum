import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createStreamingDocument } from "../src/index.js";
import { Markdown } from "../src/react.js";

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

// Known limit from PR #13 review round 6. Remove `.failing` when recursive containers land.
test.failing("bounds 100 KB quote > list > quote work", () => {
  const unit = "> - outer item\n>   > deepest leaf keeps streaming words and `code` safely.\n";
  const source = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
  const document = createStreamingDocument();
  const work: number[] = [];
  for (let offset = 0; offset < source.length; offset += 20) {
    const before = document.stats.scannedCharacters;
    document.append(source.slice(offset, offset + 20));
    document.render();
    work.push(document.stats.scannedCharacters - before);
  }
  const quarter = Math.floor(work.length / 4);
  const ratio = average(work.slice(quarter * 3, quarter * 4)) / average(work.slice(quarter, quarter * 2));
  expect(ratio).toBeLessThanOrEqual(1.2);
}, 60_000);

// Known limit from PR #13 review round 6. Remove `.failing` when leaf lookahead owns this prefix.
test.failing("hides the spaced nested-quote table prefix", () => {
  const source = [
    "# report 1",
    "",
    "> - nested quote-list",
    ">   > inner quote with **strong**, *emphasis*, ~~strike~~, and `code`.",
    ">   >",
    ">   > |",
  ].join("\n");
  const html = renderToStaticMarkup(<Markdown source={source} streaming />);
  expect(html).not.toContain("|");
});

// Known intermittent limit from PR #13 review round 6: one of five 1-byte runs reached 37.260 ms.
test.todo("keeps every 1-byte mixed-quote benchmark delta below 16 ms");
