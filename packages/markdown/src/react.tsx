import {
  Fragment,
  memo,
  type ComponentType,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createStreamingDocument,
  parseMarkdown,
  type Block,
  type Highlighter,
  type Inline,
  type ListBlock,
  type Token,
} from "./index.js";
import { CodeViewer, HighlightContext, INLINE_SPANS, isLargeCode, Tokens } from "@fulcrum/react/code";

export interface MarkdownProps {
  source: string;
  streaming?: boolean;
  highlight?: Highlighter;
  id?: string;
  /** Renderers for fenced blocks by lowercase language (`{ mermaid: MermaidFence }`); other fences stay code blocks. Pass a stable object. */
  fences?: Fences;
}

/** What a fence renderer gets: the fence's text, whether its closing fence has arrived, and the default code block. */
export interface FenceProps {
  id: string;
  code: string;
  language: string;
  /** False while the fence is still streaming in. */
  done: boolean;
  /** The highlighted code block markdown draws without a renderer. Keep it mounted in one place to keep its colors. */
  source: ReactNode;
}
export type Fences = Readonly<Record<string, ComponentType<FenceProps>>>;
type Shared = { highlight?: Highlighter; fences?: Fences };

const InlineView = ({ nodes }: { nodes: Inline[] }): ReactNode => nodes.map((node, index) => {
  const key = index;
  if (node.type === "text") return <Fragment key={key}>{node.value}</Fragment>;
  if (node.type === "pending-reference") return <span key={key} data-part="md-reference-pending">{node.value}</span>;
  if (node.type === "code") return <code key={key} data-part="md-code-inline">{node.value}</code>;
  if (node.type === "break") return <br key={key} data-part="md-break" />;
  if (node.type === "emphasis") return <em key={key} data-part="md-emphasis"><InlineView nodes={node.children} /></em>;
  if (node.type === "strong") return <strong key={key} data-part="md-strong"><InlineView nodes={node.children} /></strong>;
  if (node.type === "strike") return <del key={key} data-part="md-strike"><InlineView nodes={node.children} /></del>;
  if (node.type === "link") return node.href !== undefined
    ? <a key={key} data-part="md-link" href={node.href} title={node.title}><InlineView nodes={node.children} /></a>
    : <Fragment key={key}><InlineView nodes={node.children} /></Fragment>;
  return node.src
    ? <img key={key} data-part="md-image" src={node.src} title={node.title} alt={node.alt} />
    : <Fragment key={key}>{node.alt}</Fragment>;
});

// A large block is the shared bounded viewer: one react commit of every token of a 330k-token block froze the page
// for seconds. Each mounted range of it is highlighted on its own, through the same highlighter.
const LargeCodeBlock = ({ id, block, highlight, seed }: { id: string; block: Extract<Block, { type: "code" }>; highlight?: Highlighter; seed?: Token[] | null }) =>
  <HighlightContext.Provider value={highlight}><div data-part="md-code-block" data-language={block.language} data-size="large" data-state={block.open ? "streaming" : undefined}><CodeViewer text={block.value} language={block.language} id={id} done={!block.open} seed={seed} /></div></HighlightContext.Provider>;

// Tokens for `code`: tokens of an older revision that spell a prefix of it keep their colors and get the rest as plain
// text, so a block never shows fewer characters than its source (a closing fence waits on its done colors).
function covering(tokens: Token[] | null, code: string): Token[] | null {
  if (!tokens) return null;
  const spelled = tokens.map((token) => token.text).join("");
  if (spelled === code) return tokens;
  return code.startsWith(spelled) ? [...tokens, { text: code.slice(spelled.length) }] : null;
}

function keepColors(previous: Token[] | null, candidate: Token[] | null, code: string): Token[] | null {
  if (!candidate || !previous || candidate.some((token) => token.type) || !previous.some((token) => token.type)) return candidate;
  return covering(previous, code) ?? candidate;
}

// One component for a fence's whole life, so the tokens it has carry over when it becomes the viewer (over isLargeCode's
// limits, or with more than INLINE_SPANS tokens): its colors never blink and the commit stays bounded.
function CodeBlock({ id, block, highlight }: { id: string; block: Extract<Block, { type: "code" }>; highlight?: Highlighter }) {
  const large = isLargeCode(block.value);
  const version = useRef(0);
  const previous = useRef("");
  const mounted = useRef(false);
  const request = useRef<{ id: number; key: string; result: ReturnType<Highlighter> } | undefined>(undefined);
  const nextRequestId = useRef(0);
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [, setRevision] = useState(0);
  // The highlighter replaced this block's tokens (answered plain while its grammar was cold, now colored): ask again.
  useEffect(() => highlight?.subscribe(id, () => { request.current = undefined; setRevision((value) => value + 1); }), [highlight, id]);
  const state = block.open ? "streaming" : "done";
  if (previous.current !== block.value) {
    previous.current = block.value;
    version.current++;
  }
  const currentVersion = version.current;
  const key = `${currentVersion}:${state}:${block.language ?? ""}`;
  if (highlight && !large && request.current?.key !== key) {
    request.current = { id: ++nextRequestId.current, key, result: highlight(block.value, block.language, { id, version: currentVersion, state }) };
  }
  const requestId = request.current?.id;
  const immediate = request.current?.result && !(request.current.result instanceof Promise) ? request.current.result : null;

  useEffect(() => {
    mounted.current = true;
    if (!highlight) { setTokens(null); return () => { mounted.current = false; }; }
    const requestedVersion = currentVersion;
    const requestedId = requestId;
    const result = request.current?.result;
    if (result instanceof Promise) {
      void result.then((next) => {
        if (mounted.current && version.current === requestedVersion && request.current?.id === requestedId) {
          setTokens((previous) => keepColors(previous, next, block.value));
        }
      });
    } else setTokens((previous) => keepColors(previous, result ?? null, block.value));
    return () => { mounted.current = false; };
  }, [currentVersion, highlight, key, requestId]);

  const latest = keepColors(tokens, immediate, block.value) ?? tokens;
  const shown = covering(latest, block.value);
  if (large || (shown && shown.length > INLINE_SPANS)) return <LargeCodeBlock id={id} block={block} highlight={highlight} seed={latest} />;
  return <pre data-part="md-code-block" data-language={block.language} data-state={block.open ? "streaming" : undefined}><code>{shown ? <Tokens tokens={shown} /> : block.value}</code></pre>;
}

const isOpen = (block: Block) => block.type === "code" ? block.open : undefined;

const ListView = ({ id, block, highlight, fences }: { id: string; block: ListBlock } & Shared) => {
  const Tag = block.ordered ? "ol" : "ul";
  return <Tag data-part="md-list" start={block.ordered && block.start !== 1 ? block.start : undefined}>{block.items.map((item, index) => (
    <li key={index} data-part="md-list-item">
      {item.checked !== undefined && <input type="checkbox" disabled readOnly checked={item.checked} />}
      {item.children.map((child, childIndex) => <BlockView key={childIndex} id={`${id}:${index}:${childIndex}`} block={child} open={isOpen(child)} highlight={highlight} fences={fences} />)}
    </li>
  ))}</Tag>;
};

const BlockView = memo(function BlockView({ id, block, highlight, fences }: { id: string; block: Block; open: boolean | undefined } & Shared): ReactNode {
  // A paragraph whose only line is a held table row (index.ts) has nothing to show yet.
  if (block.type === "paragraph") return !block.children.length ? null : block.tight
    ? <InlineView nodes={block.children} />
    : <p data-part="md-paragraph"><InlineView nodes={block.children} /></p>;
  if (block.type === "heading") {
    const Tag = `h${block.level}` as "h1";
    return <Tag data-part="md-heading"><InlineView nodes={block.children} /></Tag>;
  }
  if (block.type === "code") {
    const source = <CodeBlock id={id} block={block} highlight={highlight} />;
    const Fence = block.language ? fences?.[block.language.toLowerCase()] : undefined;
    return Fence ? <Fence id={id} code={block.value} language={block.language!} done={!block.open} source={source} /> : source;
  }
  if (block.type === "list") return <ListView id={id} block={block} highlight={highlight} fences={fences} />;
  if (block.type === "blockquote") return <blockquote data-part="md-blockquote">{block.children.map((child, index) => <BlockView key={index} id={`${id}:${index}`} block={child} open={isOpen(child)} highlight={highlight} fences={fences} />)}</blockquote>;
  if (block.type === "rule") return <hr data-part="md-rule" />;
  return <table data-part="md-table"><thead><tr>{block.header.map((cell, index) => <th key={index} align={block.align[index]}><InlineView nodes={cell} /></th>)}</tr></thead>{block.rows.length ? <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} align={block.align[cellIndex]}><InlineView nodes={cell} /></td>)}</tr>)}</tbody> : null}</table>;
// An open block can be the same object, grown in place (a fence after a whole-line delta) and then closed in place: it
// re-renders while open and once more when `open` (a prop of its own, read before the object changed) turns false.
}, (prior, next) => prior.block === next.block && !(next.block.type === "code" && next.block.open) && prior.open === next.open && prior.id === next.id && prior.highlight === next.highlight && prior.fences === next.fences);

export const Markdown = memo(function Markdown({ source, streaming = false, highlight, id, fences }: MarkdownProps) {
  const documentId = id ?? "markdown";
  const state = useRef<{ document: ReturnType<typeof createStreamingDocument>; length: number; finished: boolean } | undefined>(undefined);
  let blocks: readonly Block[];
  if (!streaming) {
    blocks = parseMarkdown(source);
    state.current = undefined;
  } else {
    if (!state.current || source.length < state.current.length || !source.startsWith(state.current.document.source)) {
      state.current = { document: createStreamingDocument(), length: 0, finished: false };
    }
    const current = state.current;
    if (source.length > current.length) {
      current.document.append(source.slice(current.length));
      current.length = source.length;
    }
    blocks = current.document.render();
  }
  return <>{blocks.map((block, index) => <BlockView key={index} id={`${documentId}:${index}`} block={block} open={isOpen(block)} highlight={highlight} fences={fences} />)}</>;
});
