import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1600 } });
await p.goto("http://127.0.0.1:5191/gallery.html#markdown-crossing");
await p.waitForFunction(() => /^60 lines/.test(document.querySelector("#markdown-crossing [data-part=text-viewer-count]")?.textContent ?? ""), undefined, { timeout: 20000 });
await p.waitForTimeout(300);
console.log(await p.evaluate(() => { const v = document.querySelector<HTMLElement>("#markdown-crossing [data-part=text-viewer]")!; const c = v.querySelector<HTMLElement>("[data-part=text-viewer-content]")!; const rows=[...v.querySelectorAll<HTMLElement>("[data-part=text-viewer-row]")];
 const last = rows.at(-1)!; return JSON.stringify({ sh: v.scrollHeight, st: v.scrollTop, ch: v.clientHeight, boxH: v.getBoundingClientRect().height, border: getComputedStyle(v).borderBottomWidth, content: c.style.height, lastT: last.style.transform, lastH: last.getBoundingClientRect().height, lastBottomRel: last.getBoundingClientRect().bottom - v.getBoundingClientRect().bottom, rows: rows.map(r=>r.getBoundingClientRect().height.toFixed(3)+"@"+r.style.transform).join(" ") }); }));
await b.close();
