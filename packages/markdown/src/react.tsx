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
  id?: string;
}

const InlineView = ({ nodes }: { nodes: Inline[] }): ReactNode => nodes.map((node, index) => {
  const key = index;
  if (node.type === "text") return <Fragment key={key}>{node.value}</Fragment>;
  if (node.type === "code") return <code key={key} data-part="md-code-inline">{node.value}</code>;
  if (node.type === "break") return <br key={key} data-part="md-break" />;
  if (node.type === "emphasis") return <em key={key} data-part="md-emphasis"><InlineView nodes={node.children} /></em>;
  if (node.type === "strong") return <strong key={key} data-part="md-strong"><InlineView nodes={node.children} /></strong>;
  if (node.type === "strike") return <del key={key} data-part="md-strike"><InlineView nodes={node.children} /></del>;
  if (node.type === "link") return node.href
    ? <a key={key} data-part="md-link" href={node.href} title={node.title}><InlineView nodes={node.children} /></a>
    : <Fragment key={key}><InlineView nodes={node.children} /></Fragment>;
  return node.src
    ? <img key={key} data-part="md-image" src={node.src} title={node.title} alt={node.alt} />
    : <Fragment key={key}>{node.alt}</Fragment>;
});

const TokenView = ({ tokens }: { tokens: Token[] }) => <>{tokens.map((token, index) => token.type
  ? <span key={index} className={`tok-${token.type}`}>{token.text}</span>
  : <Fragment key={index}>{token.text}</Fragment>)}</>;

function CodeBlock({ id, block, highlight }: { id: string; block: Extract<Block, { type: "code" }>; highlight?: Highlighter }) {
  const version = useRef(0);
  const previous = useRef("");
  const mounted = useRef(false);
  const request = useRef<{ id: number; key: string; result: ReturnType<Highlighter> } | undefined>(undefined);
  const nextRequestId = useRef(0);
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const state = block.open ? "streaming" : "done";
  if (previous.current !== block.value) {
    previous.current = block.value;
    version.current++;
  }
  const currentVersion = version.current;
  const key = `${currentVersion}:${state}:${block.language ?? ""}`;
  if (highlight && request.current?.key !== key) {
    request.current = { id: ++nextRequestId.current, key, result: highlight(block.value, block.language, { id, version: currentVersion, state }) };
  }
  const immediate = request.current?.result && !(request.current.result instanceof Promise) ? request.current.result : null;

  useEffect(() => {
    mounted.current = true;
    if (!highlight) { setTokens(null); return () => { mounted.current = false; }; }
    const requestedVersion = currentVersion;
    const requestedId = request.current?.id;
    const result = request.current?.result;
    if (result instanceof Promise) {
      void result.then((next) => {
        if (mounted.current && version.current === requestedVersion && request.current?.id === requestedId) setTokens(next);
      });
    } else setTokens(result ?? null);
    return () => { mounted.current = false; };
  }, [currentVersion, highlight, key]);

  const shown = immediate ?? tokens;
  return <pre data-part="md-code-block" data-language={block.language}><code>{shown ? <TokenView tokens={shown} /> : block.value}</code></pre>;
}

const ListView = ({ id, block, highlight }: { id: string; block: ListBlock; highlight?: Highlighter }) => {
  const Tag = block.ordered ? "ol" : "ul";
  return <Tag data-part="md-list" start={block.ordered && block.start !== 1 ? block.start : undefined}>{block.items.map((item, index) => (
    <li key={index} data-part="md-list-item">
      {item.checked !== undefined && <input type="checkbox" disabled readOnly checked={item.checked} />}
      {item.children.map((child, childIndex) => <BlockView key={childIndex} id={`${id}:${index}:${childIndex}`} block={child} highlight={highlight} />)}
    </li>
  ))}</Tag>;
};

const BlockView = memo(function BlockView({ id, block, highlight }: { id: string; block: Block; highlight?: Highlighter }): ReactNode {
  if (block.type === "paragraph") return block.tight
    ? <InlineView nodes={block.children} />
    : <p data-part="md-paragraph"><InlineView nodes={block.children} /></p>;
  if (block.type === "heading") {
    const Tag = `h${block.level}` as "h1";
    return <Tag data-part="md-heading"><InlineView nodes={block.children} /></Tag>;
  }
  if (block.type === "code") return <CodeBlock id={id} block={block} highlight={highlight} />;
  if (block.type === "list") return <ListView id={id} block={block} highlight={highlight} />;
  if (block.type === "blockquote") return <blockquote data-part="md-blockquote">{block.children.map((child, index) => <BlockView key={index} id={`${id}:${index}`} block={child} highlight={highlight} />)}</blockquote>;
  if (block.type === "rule") return <hr data-part="md-rule" />;
  return <table data-part="md-table"><thead><tr>{block.header.map((cell, index) => <th key={index} align={block.align[index]}><InlineView nodes={cell} /></th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} align={block.align[cellIndex]}><InlineView nodes={cell} /></td>)}</tr>)}</tbody></table>;
});

export const Markdown = memo(function Markdown({ source, streaming = false, highlight, id }: MarkdownProps) {
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
  return <>{blocks.map((block, index) => <BlockView key={index} id={`${documentId}:${index}`} block={block} highlight={highlight} />)}</>;
});
