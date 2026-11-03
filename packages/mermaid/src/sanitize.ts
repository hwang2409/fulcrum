import DOMPurify from "dompurify";

// A url() or @import that leaves the svg (an image, a font, a tracking pixel): only #fragment references stay.
const EXTERNAL = /url\(\s*(?!["']?\s*#)|@import/i;
let purify: ReturnType<typeof DOMPurify> | undefined;
// Its own instance, made on first use: hooks added here never touch the copy mermaid sanitizes with.
function purifier() {
  if (purify) return purify;
  purify = DOMPurify(window);
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    const value = data.attrValue;
    if ((data.attrName === "href" || data.attrName === "xlink:href") && !value.trimStart().startsWith("#")) data.keepAttr = false;
    else if (EXTERNAL.test(value)) data.keepAttr = false;
  });
  return purify;
}

/**
 * Mermaid's svg as DOM nodes, never as markup: DOMPurify parses it into a fragment, drops scripts, event handlers,
 * html (foreignObject), links, external images and urls, and returns nodes this document adopts. Null when the markup
 * holds no svg.
 */
export function sanitizeSvg(markup: string): SVGSVGElement | null {
  const fragment = purifier().sanitize(markup, {
    RETURN_DOM_FRAGMENT: true,
    ADD_ATTR: ["dominant-baseline"],
    FORBID_TAGS: ["foreignObject", "foreignobject", "a", "image", "script", "iframe", "object", "embed", "animate", "set", "animateMotion", "animateTransform"],
  });
  for (const style of fragment.querySelectorAll("style")) if (EXTERNAL.test(style.textContent ?? "")) style.remove();
  const svg = fragment.firstElementChild;
  if (!(svg instanceof SVGSVGElement)) return null;
  // Natural size from the viewBox: a wide diagram scrolls in its box instead of shrinking to unreadable text.
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) {
    svg.setAttribute("width", String(Math.ceil(box.width)));
    svg.setAttribute("height", String(Math.ceil(box.height)));
    svg.style.removeProperty("max-width");
  }
  return svg;
}

/** A short parse error: mermaid's first line ("Parse error on line 2:") and its last ("Expecting ..., got ..."). */
export function shortError(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error)).split("\n").map((line) => line.trim()).filter(Boolean);
  // "Expecting 'A', 'B', 'C', 'D', ..., got 'X'": the first three it expected, then what it got
  const last = lines.at(-1)?.replace(/^(Expecting (?:'[^']*', ){3})(?:'[^']*', )*'[^']*'(, got .*)$/, "$1…$2");
  const text = lines.length > 1 && last !== lines[0] ? `${lines[0]} ${last}` : lines[0] ?? "invalid diagram";
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}
