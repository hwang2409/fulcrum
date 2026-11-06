export type ReferenceDefinition = { label: string; href: string; title: string };

export type ReferencePreview = { source: string; value: string };
export type ReferenceDisposition =
  | { kind: "ineligible" }
  | { kind: "candidate"; preview: ReferencePreview }
  | { kind: "metadata" }
  | { kind: "definition"; definition: ReferenceDefinition; consumedLines: number }
  | { kind: "rejected" };

export type ResolvedLineContext = { continuation: boolean; blank?: boolean };

type State =
  | "indent" | "label" | "after-label" | "before-destination" | "destination-start"
  | "destination-angle" | "destination-bare" | "after-destination" | "title"
  | "title-closed" | "await-title-line" | "definition" | "rejected" | "ineligible";

const unescape = (value: string) => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
const normalizeDestination = (value: string) => {
  const unescaped = unescape(value);
  try { return encodeURI(unescaped).replace(/%25([\dA-F]{2})/gi, "%$1"); } catch { return unescaped; }
};

export function normalizeReferenceLabel(value: string) {
  value = value.trim().replace(/\s+/g, " ");
  if ("ẞ".toLowerCase() === "Ṿ") value = value.replace(/ẞ/g, "ß");
  return value.toLowerCase().toUpperCase();
}

export class ReferenceDefinitionParser {
  private state: State = "indent";
  private indent = 0;
  private escaped = false;
  private labelCodePoints = 0;
  private labelHasContent = false;
  private readonly label: string[] = [];
  private readonly destination: string[] = [];
  private readonly title: string[] = [];
  private destinationDepth = 0;
  private destinationSeparated = false;
  private titleDelimiter = "";
  private titleOnLaterLine = false;
  private lineCount = 1;
  private destinationLines = 0;
  private definitionLines = 0;

  append(fragment: string): ReferenceDisposition {
    for (const character of fragment) {
      if (this.state === "await-title-line") {
        if (character === " " || character === "\t") continue;
        if (character === '"' || character === "'" || character === "(") {
          this.startTitle(character, true);
          continue;
        }
        this.state = "definition";
        break;
      }
      this.advance(character);
      if (this.state === "rejected" || this.state === "ineligible" || this.state === "definition") break;
    }
    return this.disposition();
  }

  endLine(context: ResolvedLineContext): ReferenceDisposition {
    if (this.isDone()) return this.disposition();
    if (context.blank || !context.continuation) return this.finishAtBoundary();
    switch (this.state) {
      case "label":
        if (!this.addLabel("\n")) return this.disposition();
        break;
      case "before-destination":
      case "destination-start":
        if (this.destinationLines) return this.reject();
        this.state = "destination-start";
        break;
      case "destination-bare":
        if (this.destinationDepth) return this.reject();
        this.destinationLines = this.lineCount;
        this.state = "await-title-line";
        break;
      case "after-destination":
        this.destinationLines ||= this.lineCount;
        this.state = "await-title-line";
        break;
      case "title":
        this.title.push("\n");
        break;
      case "title-closed":
        this.definitionLines = this.lineCount;
        this.state = "definition";
        return this.disposition();
      default:
        return this.rejectOrRollback();
    }
    this.lineCount++;
    return this.disposition();
  }

  finish(): ReferenceDisposition {
    return this.finishAtBoundary();
  }

  pendingDefinition(): Extract<ReferenceDisposition, { kind: "definition" }> | undefined {
    if (this.state !== "await-title-line") return undefined;
    return {
      kind: "definition",
      definition: {
        label: normalizeReferenceLabel(this.label.join("")),
        href: normalizeDestination(this.destination.join("")),
        title: "",
      },
      consumedLines: this.destinationLines,
    };
  }

  private finishAtBoundary(): ReferenceDisposition {
    if (this.state === "destination-bare" && !this.destinationDepth) {
      this.destinationLines = this.lineCount;
      this.definitionLines = this.destinationLines;
      this.state = "definition";
    } else if (this.state === "after-destination" || this.state === "await-title-line") {
      this.destinationLines ||= this.lineCount;
      this.definitionLines = this.destinationLines;
      this.state = "definition";
    } else if (this.state === "title-closed") {
      this.definitionLines = this.lineCount;
      this.state = "definition";
    } else if (this.state !== "definition") {
      return this.rejectOrRollback();
    }
    return this.disposition();
  }

  private isDone() {
    return this.state === "definition" || this.state === "rejected" || this.state === "ineligible";
  }

  private advance(character: string) {
    switch (this.state) {
      case "indent": return this.advanceIndent(character);
      case "label": return this.advanceLabel(character);
      case "after-label": this.state = character === ":" ? "before-destination" : "rejected"; return;
      case "before-destination": return this.advanceBeforeDestination(character);
      case "destination-start":
        if (character !== " " && character !== "\t") this.startDestination(character);
        return;
      case "destination-angle": return this.advanceAngleDestination(character);
      case "destination-bare": return this.advanceBareDestination(character);
      case "after-destination": return this.advanceAfterDestination(character);
      case "title": return this.advanceTitle(character);
      case "title-closed":
        if (character !== " " && character !== "\t") this.rejectOrRollback();
    }
  }

  private advanceIndent(character: string) {
    if (character === " " && this.indent < 3) {
      this.indent++;
      return;
    }
    this.state = character === "[" ? "label" : "ineligible";
  }

  private advanceLabel(character: string) {
    if (this.escaped) {
      this.escaped = false;
      this.addLabel(character);
    } else if (character === "\\") {
      this.escaped = true;
      this.addLabel(character);
    } else if (character === "[") {
      this.state = "rejected";
    } else if (character === "]") {
      this.state = this.labelHasContent ? "after-label" : "rejected";
    } else {
      this.addLabel(character);
    }
  }

  private addLabel(character: string) {
    this.labelCodePoints++;
    if (this.labelCodePoints > 999) {
      this.state = "rejected";
      return false;
    }
    this.label.push(character);
    if (!/\s/u.test(character)) this.labelHasContent = true;
    return true;
  }

  private advanceBeforeDestination(character: string) {
    if (character === " " || character === "\t") return;
    this.state = "destination-start";
    this.startDestination(character);
  }

  private startDestination(character: string) {
    if (character === "<") {
      this.state = "destination-angle";
    } else if (this.isBareCharacter(character)) {
      this.state = "destination-bare";
      this.advanceBareDestination(character);
    } else {
      this.state = "rejected";
    }
  }

  private advanceAngleDestination(character: string) {
    if (this.escaped) {
      this.escaped = false;
      this.destination.push(character);
    } else if (character === "\\") {
      this.escaped = true;
      this.destination.push(character);
    } else if (character === ">") {
      this.destinationLines = this.lineCount;
      this.state = "after-destination";
    } else if (character === "<" || character === "\n") {
      this.state = "rejected";
    } else {
      this.destination.push(character);
    }
  }

  private advanceBareDestination(character: string) {
    if (this.advanceEscapedBare(character)) return;
    if (character === "\\") {
      this.escaped = true;
      this.destination.push(character);
      return;
    }
    const code = character.codePointAt(0)!;
    if (code === 32 || code < 32 || code === 127) {
      if (this.destinationDepth) this.state = "rejected";
      else {
        this.destinationLines = this.lineCount;
        this.destinationSeparated = true;
        this.state = "after-destination";
      }
      return;
    }
    if (character === "(") {
      if (++this.destinationDepth > 32) this.state = "rejected";
    } else if (character === ")") {
      if (!this.destinationDepth) {
        this.state = "rejected";
        return;
      }
      this.destinationDepth--;
    }
    this.destination.push(character);
  }

  private advanceEscapedBare(character: string) {
    if (!this.escaped) return false;
    if (character === " ") this.state = "rejected";
    else {
      this.escaped = false;
      this.destination.push(character);
    }
    return true;
  }

  private advanceAfterDestination(character: string) {
    if (character === " " || character === "\t") {
      this.destinationSeparated = true;
      return;
    }
    if (this.destinationSeparated && (character === '"' || character === "'" || character === "(")) this.startTitle(character, false);
    else this.state = "rejected";
  }

  private startTitle(character: string, laterLine: boolean) {
    this.titleDelimiter = character === "(" ? ")" : character;
    this.titleOnLaterLine = laterLine;
    this.state = "title";
  }

  private advanceTitle(character: string) {
    if (this.escaped) {
      this.escaped = false;
      this.title.push(character);
    } else if (character === "\\") {
      this.escaped = true;
      this.title.push(character);
    } else if (character === this.titleDelimiter) {
      this.state = "title-closed";
    } else if (character === "(" && this.titleDelimiter === ")") {
      this.rejectOrRollback();
    } else {
      this.title.push(character);
    }
  }

  private isBareCharacter(character: string) {
    const code = character.codePointAt(0)!;
    return code >= 32 && code !== 127;
  }

  private rejectOrRollback(): ReferenceDisposition {
    if (this.titleOnLaterLine && this.destinationLines) {
      this.title.length = 0;
      this.definitionLines = this.destinationLines;
      this.state = "definition";
    } else {
      this.state = "rejected";
    }
    return this.disposition();
  }

  private reject(): ReferenceDisposition {
    this.state = "rejected";
    return this.disposition();
  }

  private disposition(): ReferenceDisposition {
    if (this.state === "ineligible") return { kind: "ineligible" };
    if (this.state === "rejected") return { kind: "rejected" };
    if (this.state === "definition") return {
      kind: "definition",
      definition: {
        label: normalizeReferenceLabel(this.label.join("")),
        href: normalizeDestination(this.destination.join("")),
        title: unescape(this.title.join("")),
      },
      consumedLines: this.definitionLines || this.destinationLines || this.lineCount,
    };
    if (this.state === "indent" || this.state === "label" || this.state === "after-label") {
      const value = unescape(this.label.join("")).slice(-128);
      return { kind: "candidate", preview: { source: value, value } };
    }
    return { kind: "metadata" };
  }
}
