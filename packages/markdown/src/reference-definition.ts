export type ReferenceDefinition = { label: string; href: string; title: string };

export type ReferencePreview = { source: string; value: string };
export type ReferenceDisposition =
  | { kind: "ineligible" }
  | { kind: "candidate"; preview: ReferencePreview }
  | { kind: "metadata" }
  | { kind: "definition"; definition: ReferenceDefinition; consumedLines: number }
  | { kind: "rejected" };

export type ResolvedLineContext = { continuation: boolean; blank?: boolean };

const normalize = (value: string) => unescape(value).trim().replace(/[ \t\n]+/g, " ").toUpperCase();
const unescape = (value: string) => value.replace(/\\([\\`*{}\[\]()#+.!_<>|])/g, "$1");
const titlePattern = /^(?:"([\s\S]*)"|'([\s\S]*)'|\(([\s\S]*)\))\s*$/;

function scan(source: string, eof: boolean): ReferenceDisposition {
  if (!/^ {0,3}\[/.test(source)) return { kind: "ineligible" };
  let end = -1;
  let escaped = false;
  let count = 0;
  let visible = "";
  for (let index = source.indexOf("[") + 1; index < source.length; index++) {
    const character = source[index]!;
    if (escaped) { escaped = false; count++; visible += character; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "[") return { kind: "rejected" };
    if (character === "]") { end = index; break; }
    if (character === "\n" && source.slice(index + 1).length === 0 && !eof) return { kind: "candidate", preview: { source, value: visible } };
    count += 1;
    if (count > 999) return { kind: "rejected" };
    visible += character;
  }
  if (end < 0) return eof ? { kind: "rejected" } : { kind: "candidate", preview: { source, value: visible.slice(-128) } };
  if (!visible.trim() || source[end + 1] !== ":") return { kind: "rejected" };
  const label = normalize(source.slice(source.indexOf("[") + 1, end));
  let rest = source.slice(end + 2);
  const destination = /^\s*(?:<((?:\\.|[^>])*)>|((?:\\.|[^\s()<>[\]"'])|\((?:\\.|[^()<>])*\))+)/s.exec(rest);
  if (!destination) return eof ? { kind: "rejected" } : { kind: "metadata" };
  const href = unescape(destination[1] ?? destination[0].trim());
  rest = rest.slice(destination[0].length);
  if (!rest.trim()) return eof ? { kind: "definition", definition: { label, href, title: "" }, consumedLines: source.split("\n").length } : { kind: "metadata" };
  const title = titlePattern.exec(rest.trim());
  if (!title) return rest.includes("\n") && !eof ? { kind: "metadata" } : { kind: "rejected" };
  return { kind: "definition", definition: { label, href, title: unescape(title[1] ?? title[2] ?? title[3] ?? "") }, consumedLines: source.split("\n").length };
}

export class ReferenceDefinitionParser {
  private source = "";
  private lines = 0;

  append(fragment: string): ReferenceDisposition {
    this.source += fragment;
    return scan(this.source, false);
  }

  endLine(context: ResolvedLineContext): ReferenceDisposition {
    if (context.blank || !context.continuation && this.lines > 0) return { kind: "rejected" };
    this.source += "\n";
    this.lines++;
    return scan(this.source, false);
  }

  finish(): ReferenceDisposition {
    return scan(this.source, true);
  }
}

export function parseReferenceDefinition(source: string): ReferenceDefinition | undefined {
  const result = scan(source, true);
  return result.kind === "definition" ? result.definition : undefined;
}

export function parseReferenceTitle(source: string): string | undefined {
  const match = titlePattern.exec(source.trim());
  return match ? unescape(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}
