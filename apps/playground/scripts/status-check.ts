// Status marks, rendered. ok, warn, and danger are marks only (packages/react/test/themes.test.ts scans the CSS): in
// every theme, every status word in the gallery and in the web app's own status parts is drawn in fg or muted, and no
// other text outside code and syntax spans is drawn in a status color, whatever route the color takes (an alias, an
// inline style, currentColor). Each mark keeps its 1 px bg ring. A wrapped status line hangs its lines 2+ under the
// first line's words, not under the square. Under forced colors (Windows high contrast) every mark stays visible.
import type { Browser, Page } from "playwright";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

// The web app's status parts, on its own stylesheet (apps/web is not in the gallery). Narrow enough that the
// undelivered note wraps at every width.
function webPage(theme: string) {
  const css = ["packages/react/styles.css", "packages/react/themes.css", "apps/web/src/app.css"].map(read).join("\n").replace(/@import[^;]+;/g, "");
  const badge = (tone: string) => `<span class="badge" data-tone="${tone}">${tone}</span>`;
  const state = (status: string) => `<span class="state" data-status="${status}">${status}</span>`;
  return `<!doctype html><html data-fulcrum-theme="${theme}"><head><style>${css}</style></head><body>
    <div class="run-scroll" style="width: 260px"><div data-part="item" data-kind="user">stop after the tests</div>
      <p class="undelivered" role="note">not delivered · the stop ended the turn before zeta took this steer</p></div>
    <p>${["muted", "ok", "busy", "warn", "danger"].map(badge).join(" ")}</p>
    <p>${["open", "running", "approval", "unknown", "idle"].map(state).join(" ")}</p>
    <div class="list-head"><h2>sessions</h2></div>
    <p class="note" data-tone="danger">the session file could not be read</p>
  </body></html>`;
}

// Runs in the page. Every problem names its element.
// forced undefined: only report which marks are filled.
function audit({ forced, filled }: { forced?: boolean; filled: string[] }) {
  const probe = (value: string) => {
    const span = document.createElement("span");
    span.style.color = value;
    document.body.append(span);
    const color = getComputedStyle(span).color;
    span.remove();
    return color;
  };
  const status = Object.fromEntries(["ok", "warn", "danger"].map((name) => [probe(`var(--fulcrum-${name})`), name]));
  const words = new Set([probe("var(--fulcrum-fg)"), probe("var(--fulcrum-muted)")]);
  // Text in a color that some non-status token also has (dracula's path accent is its green) is that token's, not a
  // status route; every other theme still catches a real route.
  const root = getComputedStyle(document.documentElement);
  const others = new Set([...root].filter((name) => /^--fulcrum-(?!ok$|warn$|danger$)/.test(name)).map((name) => probe(`var(${name})`)));
  const name = (node: Element) => {
    const part = node.closest("[data-part]");
    const id = node.closest<HTMLElement>("[data-id], [id]");
    return `${id ? `#${id.dataset.id ?? id.id} ` : ""}${node === part || !part ? "" : `${part.getAttribute("data-part")} > `}${node.getAttribute("data-part") ?? `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(" ")[0]}` : ""}`} "${node.textContent!.trim().slice(0, 32)}"`;
  };
  const shown = (node: Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const opaque = (color: string) => !/^rgba\(.*, 0\)$|^transparent$/.test(color);
  // A mark is a painted or outlined 7 px square. An unpainted ::before can reserve space without claiming status.
  const marks = [...document.querySelectorAll("body *")].filter(shown).flatMap((node) => {
    const before = getComputedStyle(node, "::before");
    const decorated = opaque(before.backgroundColor) || before.outlineStyle !== "none" || [before.borderTopStyle, before.borderRightStyle, before.borderBottomStyle, before.borderLeftStyle].some((style) => style !== "none");
    if (before.content !== "none" && before.content !== "normal" && before.width === "7px" && before.height === "7px" && decorated) return [{ host: node, style: before }];
    return node.getAttribute("data-part") === "run-state" ? [{ host: node, style: getComputedStyle(node) }] : [];
  });
  const problems: string[] = [];
  if (forced === undefined) return { problems, marks: marks.length, filled: marks.filter(({ style }) => opaque(style.backgroundColor)).map(({ host }) => name(host)) };
  if (!forced) {
    // The word next to each mark, and every status part's own text, is fg or muted.
    const STATUS_PARTS = '[data-part="tool-status"], [data-part="tool-approval"], [data-part="text-viewer-status"], [data-part="text-viewer-position"], [data-part="sub-agent-status"], [data-part="run-end-marker"], [data-part="run-status"], [data-part="run-notice"], [data-part="run-urgency"], [data-part="fetch-status"], [data-part="tool-exit"], [data-part="tool-empty"], [data-part="approval-error"], [data-part="composer-status"], [data-part="composer-stop"], [data-part="image-placeholder"], [data-part="notification-summary"], [data-part="mermaid-error"], [data-part="item"][data-kind="error"], .undelivered, .badge, .state, .note';
    const hosts = new Set([...marks.map(({ host }) => host).filter((host) => host.getAttribute("data-part") !== "run-state"), ...[...document.querySelectorAll(STATUS_PARTS)].filter(shown)]);
    for (const host of hosts) {
      const color = getComputedStyle(host).color;
      if (!words.has(color)) problems.push(`${name(host)}: status word is ${status[color] ? `the ${status[color]} token` : color}, not fg or muted`);
    }
    // No other text is a status color, by any route. Code, syntax, and terminal spans keep their own palettes.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const node = text.parentElement!;
      if (!text.textContent!.trim() || !shown(node) || hosts.has(node) || node.closest('pre, code, svg, [class*="tok-"], [class*="ansi"], [data-part="diff-stat"], [data-part="md-code-block"], #theme')) continue;
      const style = getComputedStyle(node);
      for (const color of new Set([style.color, style.webkitTextFillColor])) if (status[color] && !others.has(color)) problems.push(`${name(node)}: text is the ${status[color]} token`);
    }
    for (const { host, style } of marks) {
      if (status[style.backgroundColor] && !(style.outlineStyle === "solid" && style.outlineWidth === "1px" && parseFloat(style.outlineOffset) >= 0)) problems.push(`${name(host)}: ${status[style.backgroundColor]} mark has no 1 px bg ring`);
    }
    // A wrapped status line hangs: lines 2+ start where the first line's words start, past the square.
    for (const host of document.querySelectorAll<HTMLElement>('[data-hang], .undelivered, [data-part="approval-error"], [data-part="run-notice"][data-tone="error"]')) {
      if (!shown(host)) continue;
      const text = [...host.querySelectorAll("*"), host].flatMap((node) => [...node.childNodes]).find((child) => child.nodeType === Node.TEXT_NODE && child.textContent!.trim() && shown(child.parentElement!));
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = [...range.getClientRects()].filter((rect) => rect.width > 0).reduce<DOMRect[]>((all, rect) => (all.length && Math.abs(all.at(-1)!.top - rect.top) < 2 ? all : [...all, rect]), []);
      if (lines.length < 2) { problems.push(`${name(host)}: did not wrap, so its hang was not checked`); continue; }
      const off = lines.slice(1).filter((line) => Math.abs(line.left - lines[0]!.left) > 1);
      if (off.length) problems.push(`${name(host)}: wrapped lines start at x ${off.map((line) => Math.round(line.left)).join(", ")}, the first line's words at ${Math.round(lines[0]!.left)}; lines 2+ must hang under the words, not the square`);
    }
  } else {
    // Under forced colors a mark is visible when its fill or its ring differs from what it sits on.
    const background = (start: Element) => {
      for (let node: Element | null = start; node; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        if (!/^rgba\(.*, 0\)$|^transparent$/.test(color)) return color;
      }
      return probe("Canvas");
    };
    const wasFilled = new Set(filled);
    for (const { host, style } of marks) {
      const under = background(host.getAttribute("data-part") === "run-state" ? host.parentElement! : host);
      const fill = opaque(style.backgroundColor) && style.backgroundColor !== under;
      const ring = [style.outlineStyle === "solid" && parseFloat(style.outlineWidth) >= 1 && style.outlineColor !== under && style.outlineColor !== style.backgroundColor ? style.outlineColor : "",
        style.borderTopStyle === "solid" && parseFloat(style.borderTopWidth) >= 1 && style.borderTopColor !== under ? style.borderTopColor : ""].some(Boolean);
      if (!fill && !ring) problems.push(`${name(host)}: mark is invisible in forced colors (fill ${style.backgroundColor}, outline ${style.outlineStyle} ${style.outlineColor} on ${under})`);
      else if (!fill && wasFilled.has(name(host))) problems.push(`${name(host)}: a filled mark turns hollow in forced colors (fill ${style.backgroundColor} on ${under}), which reads as canceled; paint it CanvasText with forced-color-adjust: none`);
    }
  }
  return { problems, marks: marks.length, filled: [] as string[] };
}

async function sweep(page: Page, where: string, failures: string[], forced: boolean, minMarks: number) {
  // Forced colors: which marks are filled with forced colors off, on the same DOM.
  let filled: string[] = [];
  if (forced) {
    await page.emulateMedia({ forcedColors: "none" });
    filled = (await page.evaluate(audit, { filled })).filled;
    await page.emulateMedia({ forcedColors: "active" });
  }
  const { problems, marks } = await page.evaluate(audit, { forced, filled });
  if (marks < minMarks) failures.push(`${where}: found ${marks} marks, expected at least ${minMarks}; the page did not render its status parts`);
  for (const problem of problems) failures.push(`${where}: ${problem}`);
  if (!problems.length && marks >= minMarks) console.log(`ok   ${where}: ${marks} marks${forced ? " visible" : ", words in fg or muted"}`);
}

export async function checkStatusMarks(browser: Browser, port: number, shots?: string): Promise<string[]> {
  const failures: string[] = [];
  let themes: string[] = [];
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    if (!themes.length) {
      await page.goto(`http://127.0.0.1:${port}/gallery.html`);
      themes = await page.$$eval("#theme option", (options) => options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== "auto"));
    }
    // Colors do not depend on the width: every theme at 1440, two at 390. Forced colors: one theme at each width.
    for (const theme of width === 1440 ? themes : ["nord", "catppuccin-latte"]) {
      for (const forced of theme === "nord" ? [false, true] : [false]) {
        await page.emulateMedia({ forcedColors: forced ? "active" : "none" });
        await page.goto(`http://127.0.0.1:${port}/gallery.html?theme=${theme}`);
        await page.waitForSelector('#composer-send-error [data-part="composer-status"][data-tone="danger"]');
        // A host may let the send failure wrap (gamma does); it must then hang like every other status line.
        await page.evaluate(() => {
          const status = document.querySelector<HTMLElement>('#composer-send-error [data-part="composer-status"]')!;
          status.dataset.hang = "";
          Object.assign(status.style, { flexBasis: "100%", height: "auto", whiteSpace: "normal", maxWidth: "200px" });
        });
        await sweep(page, `gallery ${theme}${forced ? " forced" : ""} @ ${width}`, failures, forced, 40);
        if (shots && (theme === "nord" || theme === "catppuccin-latte")) for (const id of ["composer-send-error", "tools-error"]) {
          // Off-screen demos skip rendering (content-visibility): bring each into view and let it paint.
          await page.locator(`#${id}`).scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
          await page.locator(`#${id}`).screenshot({ path: `${shots}/${id}-${theme}${forced ? "-forced" : ""}-${width}.png` });
        }
        await page.setContent(webPage(theme));
        await sweep(page, `web ${theme}${forced ? " forced" : ""} @ ${width}`, failures, forced, 10);
        if (shots && (theme === "nord" || theme === "catppuccin-latte")) await page.screenshot({ path: `${shots}/web-${theme}${forced ? "-forced" : ""}-${width}.png`, clip: { x: 0, y: 0, width: Math.min(width, 640), height: 200 } });
      }
    }
    await page.close();
  }
  return failures;
}

if (import.meta.main) {
  const { chromium } = await import("playwright");
  const port = Number(process.env.PORT ?? 5173);
  const browser = await chromium.launch();
  const failures = await checkStatusMarks(browser, port, process.env.SHOTS).finally(() => browser.close());
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(failures.length ? 1 : 0);
}
