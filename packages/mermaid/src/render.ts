// The lazy half of @fulcrum/mermaid: the first diagram on a page imports this module, and with it mermaid.
import mermaid from "mermaid";
import { sanitizeSvg, shortError } from "./sanitize.js";
import { themeVariables, TOKENS, type Token } from "./theme.js";

export type Rendered = { svg: SVGSVGElement; label: string } | { error: string };

let renders = 0;
const pixel = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d", { willReadFrequently: true });

// A token as #rrggbb: mermaid derives colors from these with khroma, which reads no var() or color-mix().
function colors(host: Element): Partial<Record<Token, string>> {
  const probe = document.createElement("span");
  probe.hidden = true;
  host.append(probe);
  const resolved: Partial<Record<Token, string>> = {};
  try {
    const style = getComputedStyle(probe);
    const declared = getComputedStyle(host);
    for (const name of TOKENS) {
      if (!declared.getPropertyValue(`--fulcrum-${name}`).trim()) continue;
      probe.style.color = `var(--fulcrum-${name})`;
      if (!pixel) continue;
      pixel.clearRect(0, 0, 1, 1);
      pixel.fillStyle = style.color;
      pixel.fillRect(0, 0, 1, 1);
      const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
      resolved[name] = `#${[r, g, b].map((value) => value!.toString(16).padStart(2, "0")).join("")}`;
    }
  } finally {
    probe.remove();
  }
  return resolved;
}

// Directives (%%{init}%%) and frontmatter in the diagram cannot change these: the security level, html labels, the
// theme, and the limits stay what fulcrum set.
const SECURE = ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels", "theme", "themeVariables", "themeCSS", "darkMode", "fontFamily", "look", "arrowMarkerAbsolute"];

/** Draws `code` with the tokens and font at `host`. Never throws: an invalid diagram is an `error`. */
export async function renderMermaid(code: string, host: Element): Promise<Rendered> {
  await document.fonts?.ready; // mermaid measures label text: the page's font must be the one it measures
  const style = getComputedStyle(host);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    secure: SECURE,
    theme: "base",
    look: "classic",
    fontFamily: style.fontFamily,
    themeVariables: themeVariables(colors(host), style.fontFamily, style.fontSize),
    // gantt sizes itself to mermaid's measuring element in <body>, the page's width: it takes the box's width instead
    gantt: { useWidth: Math.max(480, host.clientWidth - 34), axisFormat: "%m-%d" },
  });
  const id = `fulcrum-mermaid-${++renders}`;
  try {
    const { svg, diagramType } = await mermaid.render(id, code);
    const element = sanitizeSvg(svg);
    if (!element) return { error: "the diagram could not be drawn" };
    return { svg: element, label: label(element, diagramType) };
  } catch (error) {
    return { error: shortError(error) };
  } finally {
    for (const leftover of [id, `d${id}`]) document.getElementById(leftover)?.remove();
  }
}

// The svg's accessible name: the diagram's accTitle when it has one, else its type and the first label texts.
function label(svg: SVGSVGElement, type: string): string {
  svg.setAttribute("role", "img");
  const titled = svg.getAttribute("aria-labelledby");
  const title = titled ? svg.querySelector(`[id="${CSS.escape(titled)}"]`)?.textContent?.trim() : "";
  const words = [...new Set([...svg.querySelectorAll("text")].map((node) => node.textContent?.trim() ?? "").filter(Boolean))].join(", ");
  const kind = type.replace(/-v\d+$|Diagram$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const name = title || `${kind} diagram${words ? `: ${words.length > 160 ? `${words.slice(0, 159)}…` : words}` : ""}`;
  svg.setAttribute("aria-label", name);
  svg.removeAttribute("aria-labelledby");
  return name;
}
