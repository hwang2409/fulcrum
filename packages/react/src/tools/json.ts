// Re-indenting copies the source text, so it never rounds big numbers or reorders keys the way parse + stringify can.
const MAX_PRETTY_CHARS = 256 * 1024;
const MAX_DETECT_CHARS = 2 * 1024 * 1024;

/**
 * Whether text is one JSON object or array as a whole (checked by parsing, never by guessing), and the text to show:
 * compact JSON under a size bound is indented two spaces; anything already formatted stays exactly as sent.
 */
export function jsonText(text: string): { text: string; json: boolean } {
  const first = text.trimStart()[0];
  if ((first !== "{" && first !== "[") || text.length > MAX_DETECT_CHARS) return { text, json: false };
  try {
    JSON.parse(text);
  } catch {
    return { text, json: false };
  }
  return { text: text.length <= MAX_PRETTY_CHARS && !text.trim().includes("\n") ? indent(text.trim()) : text, json: true };
}

function indent(source: string): string {
  let out = "";
  let depth = 0;
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"') {
      let j = i + 1;
      while (source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
    } else if (c === "{" || c === "[") {
      let j = i + 1;
      while (source[j] === " " || source[j] === "\t" || source[j] === "\r") j++;
      if (source[j] === (c === "{" ? "}" : "]")) { out += c + source[j]; i = j; }
      else { depth++; out += c + newline(); }
    } else if (c === "}" || c === "]") { depth--; out += newline() + c; }
    else if (c === ",") out += `,${newline()}`;
    else if (c === ":") out += ": ";
    else if (c !== " " && c !== "\t" && c !== "\r") out += c;
  }
  return out;
}
