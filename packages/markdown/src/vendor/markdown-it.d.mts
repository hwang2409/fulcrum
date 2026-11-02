type Attrs = Array<[string, string]> | null;

export type MarkdownToken = {
  type: string;
  tag: string;
  nesting: -1 | 0 | 1;
  level: number;
  attrs: Attrs;
  map: [number, number] | null;
  markup: string;
  info: string;
  content: string;
  hidden: boolean;
  children: MarkdownToken[] | null;
  attrGet(name: string): string | null;
};

type MarkdownEnvironment = { references?: Record<string, { href: string; title: string }> };

declare class MarkdownIt {
  constructor(options?: { html?: boolean; linkify?: boolean; breaks?: boolean; typographer?: boolean });
  parse(source: string, environment: MarkdownEnvironment): MarkdownToken[];
}

export default MarkdownIt;
