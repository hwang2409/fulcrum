import {
  Fragment,
  memo,
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

export interface MarkdownProps {
  source: string;
  streaming?: boolean;
  highlight?: Highlighter;
}

const InlineView = ({ nodes }: { nodes: readonly Inline[] }) => (
  <>
    {nodes.map((node, index) => {
      switch (node.type) {
        case "text": return <Fragment key={index}>{node.value}</Fragment>;
        case "break": return <br key={index} data-part="md-break" />;
        case "code": return <code key={index} data-part="md-code-inline">{node.value}</code>;
        case "emphasis": return <em key={index} data-part="md-emphasis"><InlineView nodes={node.children} /></em>;
        case "strong": return <strong key={index} data-part="md-strong"><InlineView nodes={node.children} /></strong>;
        case "strike": return <del key={index} data-part="md-strike"><InlineView nodes={node.children} /></del>;
        case "link": return node.href
          ? <a key={index} data-part="md-link" href={node.href}><InlineView nodes={node.children} /></a>
          : <Fragment key={index}><InlineView nodes={node.children} /></Fragment>;
      }
    })}
  </>
);

const completeLines = (code: string, open: boolean) => {
  if (!open) return code;
  const end = code.lastIndexOf("\n");
  return end < 0 ? "" : code.slice(0, end + 1);
};

function initialHighlight(highlight: Highlighter | undefined, code: string, language: string | undefined) {
  if (!highlight || !code) return { tokens: null as Token[] | null };
  const value = highlight(code, language);
  return value instanceof Promise
    ? { tokens: null as Token[] | null, pending: value }
    : { tokens: value };
}

const Tokens = ({ tokens }: { tokens: readonly Token[] }) => (
  <>{tokens.map((token, index) => token.type
    ? <span key={index} className={`tok-${token.type}`}>{token.content}</span>
    : <Fragment key={index}>{token.content}</Fragment>)}</>
);

function CodeBlock({ block, highlight }: { block: Extract<Block, { type: "code" }>; highlight?: Highlighter }) {
  const ready = completeLines(block.value, Boolean(block.open));
  const initial = useRef<{
    source: string;
    tokens: Token[] | null;
    pending?: Promise<Token[]>;
  } | undefined>(undefined);
  if (!initial.current) initial.current = { source: ready, ...initialHighlight(highlight, ready, block.language) };
  const [result, setResult] = useState({ source: initial.current.source, tokens: initial.current.tokens });
  const processed = useRef(initial.current.source);
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const initialQueued = useRef(false);
  useEffect(() => {
    if (!initial.current?.pending || initialQueued.current) return;
    initialQueued.current = true;
    queue.current = initial.current.pending.then((tokens) => {
      if (mounted.current) setResult({ source: initial.current!.source, tokens });
    });
  }, []);
  useEffect(() => {
    if (!highlight || ready.length <= processed.current.length) return;
    const source = ready;
    const suffix = source.slice(processed.current.length);
    processed.current = source;
    queue.current = queue.current.then(async () => {
      const tokens = await highlight(suffix, block.language);
      if (mounted.current) setResult((prior) => ({
        source,
        tokens: tokens ? [...(prior.tokens ?? []), ...tokens] : null,
      }));
    });
  }, [block.language, highlight, ready]);
  const rest = block.value.slice(result.source.length);
  return (
    <pre data-part="md-code-block" data-language={block.language}>
      <code>{result.tokens ? <Tokens tokens={result.tokens} /> : result.source}{rest}</code>
    </pre>
  );
}

const ListView = ({ block, highlight }: { block: ListBlock; highlight?: Highlighter }) => {
  const children = block.items.map((item, index) => (
    <li key={index} data-part="md-list-item">
      {item.checked === undefined ? null : <input type="checkbox" disabled checked={item.checked} readOnly />}
      <InlineView nodes={item.children} />
      {item.nested ? <ListView block={item.nested} highlight={highlight} /> : null}
    </li>
  ));
  return block.ordered
    ? <ol data-part="md-list" start={block.start === 1 ? undefined : block.start}>{children}</ol>
    : <ul data-part="md-list">{children}</ul>;
};

const BlockView = memo(function BlockView({ block, highlight }: { block: Block; highlight?: Highlighter }): ReactNode {
  switch (block.type) {
    case "paragraph": return <p data-part="md-paragraph"><InlineView nodes={block.children} /></p>;
    case "heading": {
      const Tag = `h${block.level}` as "h1";
      return <Tag data-part="md-heading"><InlineView nodes={block.children} /></Tag>;
    }
    case "rule": return <hr data-part="md-rule" />;
    case "code": return <CodeBlock block={block} highlight={highlight} />;
    case "list": return <ListView block={block} highlight={highlight} />;
    case "blockquote": return <blockquote data-part="md-blockquote">{block.children.map((child, index) => <BlockView key={index} block={child} highlight={highlight} />)}</blockquote>;
    case "table": return (
      <table data-part="md-table">
        <thead><tr>{block.header.map((cell, index) => <th key={index} style={block.align[index] ? { textAlign: block.align[index] } : undefined}><InlineView nodes={cell} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} style={block.align[index] ? { textAlign: block.align[index] } : undefined}><InlineView nodes={cell} /></td>)}</tr>)}</tbody>
      </table>
    );
  }
});

/** Streaming mode preserves completed block objects; only its open tail receives a new object. */
export const Markdown = memo(function Markdown({ source, streaming = false, highlight }: MarkdownProps) {
  const state = useRef<{ document: ReturnType<typeof createStreamingDocument>; length: number; finished: boolean } | undefined>(undefined);
  let blocks: readonly Block[];
  if (!streaming && !state.current) {
    blocks = parseMarkdown(source);
  } else {
    if (!state.current || source.length < state.current.length || state.current.finished && source.length !== state.current.length)
      state.current = { document: createStreamingDocument(), length: 0, finished: false };
    const current = state.current;
    if (source.length > current.length) current.document.append(source.slice(current.length));
    current.length = source.length;
    if (!streaming && !current.finished) { current.document.finish(); current.finished = true; }
    blocks = current.document.render();
  }
  return <>{blocks.map((block, index) => <BlockView key={index} block={block} highlight={highlight} />)}</>;
});
