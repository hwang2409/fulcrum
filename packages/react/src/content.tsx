import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { safeUrl, type ContentBlock, type FileContentBlock, type ImageContentBlock, type RunItem } from "@fulcrum/core";
import { useItem, useMedia } from "./hooks.js";
import type { ItemProps } from "./parts.js";
import { boundText, bytes, MAX_SUMMARY_CHARS } from "./tools/common.js";
import { CopyButton, TextViewer, type TextFormat } from "./tools/text-viewer.js";

export type MarkdownContentProps = { id: string; source: string; streaming: boolean };
/** What every block renderer gets, the default ones and a host's own. */
export type ContentBlockProps = {
  block: ContentBlock;
  /** Unique per block and stable while the message streams: the message id, then the block's position. */
  id: string;
  /** The block still grows: its message streams and it is the last block. */
  streaming: boolean;
  /** The message's markdown renderer, when the message renders markdown. */
  markdown?: ComponentType<MarkdownContentProps>;
  /** Opens a file or image. Without it a file opens its link, and an image opens in a dialog. */
  onOpen?: (block: FileContentBlock | ImageContentBlock) => void;
};
/** Keys are block types (`text`, `reasoning`, `source`, `file`, `image`, or any other); a host's renderer wins. */
export type BlockRenderers = Partial<Record<string, ComponentType<ContentBlockProps>>>;
export type MessageProps = ItemProps & {
  /** Markdown is enabled for assistant messages when a renderer is supplied. */
  markdown?: ComponentType<MarkdownContentProps> | false;
  /** Use `all` to render user-role messages as markdown too. */
  markdownFor?: "assistant" | "all";
  /** Per block type overrides of the default renderers. Pass a stable object: a new one re-renders every block. */
  blocks?: BlockRenderers;
  onOpen?: ContentBlockProps["onOpen"];
};

// Block types are adapter data: "constructor" must not find Object.prototype.constructor.
const own = (renderers: BlockRenderers | undefined, type: string) => (renderers && Object.hasOwn(renderers, type) ? renderers[type] : undefined);

type MessageItem = Extract<RunItem, { type: "message" }>;
type Part = { index: number; block: ContentBlock };

const pre = { whiteSpace: "pre-wrap" } as const;
const hidden: CSSProperties = { position: "absolute", width: 1, height: 1, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap" };
const JSON_FORMAT: TextFormat = { language: "json" };

const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const label = (value: string, limit = MAX_SUMMARY_CHARS) => boundText(value.replace(/\s+/g, " ").trim(), limit).text;
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * The message as an ordered list: its content blocks, then its streaming text tail. Adjacent text joins into one run,
 * keyed by the position of its first block, so a run keeps its key when the reducer moves the tail into the content.
 */
function messageParts(item: MessageItem): Part[] {
  const parts: Part[] = [];
  const add = (index: number, block: ContentBlock) => {
    const last = parts.at(-1);
    if (block.type === "text" && last?.block.type === "text") last.block = { type: "text", text: String(last.block.text) + String(block.text) };
    else parts.push({ index, block });
  };
  item.message.content.forEach((block, index) => add(index, block));
  if (item.text !== undefined) add(item.message.content.length, { type: "text", text: item.text });
  return parts;
}

export const Message = memo(function Message({ id, className, markdown: Markdown, markdownFor = "assistant", blocks, onOpen }: MessageProps) {
  const item = useItem(id);
  if (item?.type !== "message") return null;
  const Rich = Markdown && (markdownFor === "all" || item.message.role === "assistant") ? Markdown : undefined;
  const parts = messageParts(item);
  return (
    <div
      className={className}
      style={Rich ? undefined : pre}
      data-part="message"
      data-kind="message"
      data-id={id}
      data-role={item.message.role}
      data-state={item.active ? "streaming" : "done"}
      data-format={Rich ? "markdown" : "text"}
    >
      {parts.map(({ index, block }, position) => {
        const streaming = item.active && position === parts.length - 1;
        // The first block keeps the message id, so a plain text message renders exactly as it did before blocks.
        const blockId = index === 0 ? id : `${id}#${index}`;
        const Block = own(blocks, block.type) ?? own(defaultBlocks, block.type);
        if (Block) return <Block key={index} block={block} id={blockId} streaming={streaming} markdown={Rich} onOpen={onOpen} />;
        if (block.type !== "text") return <UnknownBlock key={index} block={block} id={blockId} streaming={streaming} />;
        const text = String(block.text);
        return Rich ? <Rich key={index} id={blockId} source={text} streaming={streaming} /> : <Fragment key={index}>{text}</Fragment>;
      })}
    </div>
  );
});

// The redacted case has nothing to open: the provider sent the reasoning encrypted.
const redacted = (
  <div data-part="reasoning" data-state="redacted">
    <div data-part="reasoning-header"><span data-part="reasoning-name">reasoning</span><span data-part="reasoning-status">redacted by the provider</span></div>
  </div>
);
const newestLine = (text: string) => text.slice(-400).split("\n").filter((line) => line.trim()).at(-1)?.trim() ?? "";
const wordCount = (text: string) => {
  const words = text.split(/\s+/).filter(Boolean).length;
  return `${words} ${words === 1 ? "word" : "words"}`;
};

/** True once a block this component saw stream has finished. History (mounted finished) never turns it on. */
function useFinishedAfterStreaming(streaming: boolean) {
  const [finished, setFinished] = useState(false);
  const streamed = useRef(streaming);
  useEffect(() => {
    if (streamed.current && !streaming) setFinished(true);
    streamed.current ||= streaming;
  }, [streaming]);
  return finished;
}

/**
 * Reasoning: a named disclosure, closed by default. While it streams the header says "thinking" and shows the newest
 * words; its body renders only while open. A screen reader hears "reasoning finished" once, when a block it saw stream
 * finishes, never per token, and never for history.
 */
export const ReasoningBlock = memo(function ReasoningBlock({ block, id, streaming, markdown: Markdown }: ContentBlockProps) {
  const [open, setOpen] = useState(false);
  const finished = useFinishedAfterStreaming(streaming);
  const text = typeof block.text === "string" ? block.text : "";
  if (block.redacted === true) return redacted;
  if (!streaming && text.trim() === "") return null;
  return (
    <>
      <span data-part="reasoning-live" role="status" style={hidden}>{finished ? "reasoning finished" : ""}</span>
      <details data-part="reasoning" data-state={streaming ? "streaming" : "done"} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary data-part="reasoning-header">
          <span data-part="reasoning-name">reasoning</span>
          <span data-part="reasoning-status">{streaming ? "thinking" : wordCount(text)}</span>
          {streaming && !open ? <span data-part="reasoning-preview" aria-hidden="true"><span>{newestLine(text)}</span></span> : null}
        </summary>
        {open ? <ReasoningBody id={id} text={text} streaming={streaming} markdown={Markdown} /> : null}
      </details>
    </>
  );
});

function ReasoningBody({ id, text, streaming, markdown: Markdown }: { id: string; text: string; streaming: boolean; markdown: ContentBlockProps["markdown"] }) {
  return <div data-part="reasoning-body" style={Markdown ? undefined : pre}>{Markdown ? <Markdown id={id} source={text} streaming={streaming} /> : text}</div>;
}

// A link's visible address: no scheme, no trailing slash, one bounded line.
const address = (href: string) => label(href.replace(/^(?:https?:\/\/|mailto:)/i, "").replace(/\/$/, ""), 120);
// The last path segment of an http(s) address; never of a data: URL, so base64 never becomes a name.
const fileName = (url: unknown) => {
  const href = safeUrl(url);
  if (!href || !/^https?:/i.test(href)) return undefined;
  try {
    return str(decodeURIComponent(new URL(href).pathname.split("/").pop() ?? ""));
  } catch {
    return undefined;
  }
};

/** A cited source: a web page links out (http, https, or mailto only); a document shows its name and type. */
export const SourceBlock = memo(function SourceBlock({ block }: ContentBlockProps) {
  const href = safeUrl(block.url);
  const shown = href ? address(href) : undefined;
  const title = str(block.title) ?? str(block.filename) ?? shown ?? "untitled source";
  const mediaType = str(block.mediaType);
  return (
    <div data-part="source">
      <span data-part="block-label">source</span>
      {href
        ? <a data-part="source-link" href={href} target="_blank" rel="noopener noreferrer">{label(title)}</a>
        : <span data-part="source-title">{label(title)}</span>}
      {shown && shown !== title ? <span data-part="source-address">{shown}</span> : null}
      {mediaType ? <span data-part="block-type">{label(mediaType, 80)}</span> : null}
    </div>
  );
});

function Facts({ mediaType, size }: { mediaType: unknown; size: unknown }) {
  const type = str(mediaType);
  const length = count(size);
  return <>
    {type ? <span data-part="block-type">{label(type, 80)}</span> : null}
    {length !== undefined ? <span data-part="block-size">{bytes(length)}</span> : null}
  </>;
}

/** A file: its name, type, and size, and "open" through the host's `onOpen`, else its http(s) link. */
export const FileBlock = memo(function FileBlock({ block, onOpen }: ContentBlockProps) {
  const file = block as FileContentBlock;
  const name = str(file.filename) ?? str(file.title) ?? fileName(file.url) ?? "untitled file";
  const href = safeUrl(file.url);
  return (
    <div data-part="file">
      <span data-part="block-label">file</span>
      <span data-part="file-name">{label(name)}</span>
      <Facts mediaType={file.mediaType} size={file.size} />
      {onOpen
        ? <button type="button" data-action="open" aria-label={`open ${label(name)}`} onClick={() => onOpen(file)}>open</button>
        : href ? <a data-action="open" href={href} target="_blank" rel="noopener noreferrer" aria-label={`open ${label(name)}`}>open</a> : null}
    </div>
  );
});

// Images draw at most 360px tall; a known size reserves its exact box, an unknown one a fixed frame.
const dimension = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
type ImageState =
  | { status: "idle" | "loading" | "blocked" | "error" | "unavailable" }
  | { status: "ready"; url: string };
type LazyImage = ImageContentBlock & { source: NonNullable<ImageContentBlock["source"]> };

function imageState(image: ImageContentBlock, lazy: LazyImage | undefined, media: ReturnType<typeof useMedia>, decodeFailures: number): ImageState {
  const url = safeUrl(image.url, "image") ?? (media.state.status === "ready" ? media.state.url : undefined);
  if (!url && (!lazy || !media.available)) return { status: "blocked" };
  if (media.state.status === "error" && (media.state.error as { code?: unknown }).code === "not_available") return { status: "unavailable" };
  if (decodeFailures > 1) return { status: "error" };
  if (url) return { status: "ready", url };
  return { status: media.state.status === "ready" ? "idle" : media.state.status };
}

function useImageLifecycle(image: ImageContentBlock, onOpen: ContentBlockProps["onOpen"]) {
  const lazy = image.source?.kind === "lazy" ? image as LazyImage : undefined;
  const [decodeFailures, setDecodeFailures] = useState(0);
  const [near, setNear] = useState(false);
  const [viewing, setViewing] = useState(false);
  const frame = useCallback((element: HTMLElement | null) => {
    if (!element || typeof IntersectionObserver === "undefined") { if (element) setNear(true); return; }
    const observer = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), { rootMargin: "400px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const media = useMedia(lazy, near || viewing);
  const state = imageState(image, lazy, media, decodeFailures);
  const open = () => { if (state.status === "ready") onOpen ? onOpen({ ...image, url: state.url }) : setViewing(true); };
  const close = () => setViewing(false);
  const decodeError = () => { if (lazy && decodeFailures === 0) media.retry(); setDecodeFailures(decodeFailures + 1); };
  const retry = () => { setDecodeFailures(0); media.retry(); };
  return { close, decodeError, frame, lazy: !!lazy, open, retry, state, viewing };
}

function ImageFrame({ box, height, lifecycle, name, width }: { box?: CSSProperties; height?: number; lifecycle: ReturnType<typeof useImageLifecycle>; name: string; width?: number }) {
  switch (lifecycle.state.status) {
    case "ready":
      return <button type="button" data-part="image-open" style={box} aria-label={`open image: ${name}`} onClick={lifecycle.open}>
        <img src={lifecycle.state.url} alt={name} width={width} height={height} onError={lifecycle.decodeError} />
      </button>;
    case "blocked":
      return <div data-part="image-placeholder"><span>image not shown: unsupported address</span></div>;
    case "unavailable":
      return <div data-part="image-placeholder" style={box}>
        <span>image no longer available</span>
        {lifecycle.lazy ? <button type="button" data-action="retry" onClick={lifecycle.retry}>retry</button> : null}
      </div>;
    case "error":
      return <div data-part="image-placeholder" style={box}>
        <span>image failed to load</span>
        <button type="button" data-action="retry" onClick={lifecycle.retry}>retry</button>
      </div>;
    case "loading":
    case "idle":
      return <div data-part="image-placeholder" style={box} aria-busy={lifecycle.state.status === "loading" || undefined}><span>loading image</span></div>;
    default: {
      const unreachable: never = lifecycle.state;
      return unreachable;
    }
  }
}

function ImageCaption({ image, name }: { image: ImageContentBlock; name: string }) {
  return <figcaption data-part="image-caption"><span data-part="block-label">image</span><span data-part="file-name">{name}</span><Facts mediaType={image.mediaType} size={image.size} /></figcaption>;
}

function ImageFullView({ lifecycle, name }: { lifecycle: ReturnType<typeof useImageLifecycle>; name: string }) {
  if (!lifecycle.viewing || lifecycle.state.status !== "ready") return null;
  return <dialog ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal?.(); }} data-part="image-dialog" aria-label={name} onClose={lifecycle.close} onClick={(event) => { event.target === event.currentTarget && lifecycle.close(); }}>
    <img src={lifecycle.state.url} alt={name} />
    <button type="button" data-action="close" onClick={lifecycle.close}>close</button>
  </dialog>;
}

/**
 * An image in a box reserved before it loads, so nothing below it moves. Clicking it calls the host's `onOpen`, or
 * opens it full size in a dialog. Its address is never text: alt, captions, and errors use its name or "image".
 */
export const ImageBlock = memo(function ImageBlock({ block, onOpen }: ContentBlockProps) {
  const image = block as ImageContentBlock;
  const lifecycle = useImageLifecycle(image, onOpen);
  const width = dimension(image.width);
  const height = dimension(image.height);
  const name = label(str(image.alt) ?? str(image.filename) ?? fileName(image.url) ?? "image");
  const box = width && height ? { width: Math.min(width, (360 * width) / height), aspectRatio: `${width} / ${height}` } : undefined;
  return <figure ref={lifecycle.frame} data-part="image" data-size={box ? "known" : "unknown"} data-state={lifecycle.state.status}>
    <ImageFrame box={box} height={height} lifecycle={lifecycle} name={name} width={width} />
    <ImageCaption image={image} name={name} />
    <ImageFullView lifecycle={lifecycle} name={name} />
  </figure>;
});

const json = (block: ContentBlock) => {
  try {
    return JSON.stringify(block, null, 2) ?? "";
  } catch {
    return "this block cannot be shown as json";
  }
};

/** Any other block: its type on one line, the json behind "show", and a copy of the whole block, so nothing is lost. */
export const UnknownBlock = memo(function UnknownBlock({ block, id }: ContentBlockProps) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => (open ? json(block) : undefined), [block, open]);
  const type = label(String(block.type), 64);
  return (
    <div data-part="block-unknown">
      <div data-part="block-unknown-header">
        <span data-part="block-label">unsupported block</span>
        <span data-part="block-type">{type}</span>
        <span data-part="block-actions">
          <button type="button" data-action="show" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "hide json" : "show json"}</button>
          <CopyButton label="json" value={() => json(block)} />
        </span>
      </div>
      {value !== undefined ? <TextViewer text={value} id={`${id}:json`} label="json" part="tool-args" format={JSON_FORMAT} /> : null}
    </div>
  );
});

const defaultBlocks: BlockRenderers = { reasoning: ReasoningBlock, source: SourceBlock, file: FileBlock, image: ImageBlock };

/** A tool result's blocks (`ToolResult.blocks`: images, ...), in order, under the tool's output. */
export function ToolResultBlocks({ id, blocks }: { id: string; blocks: readonly ContentBlock[] }) {
  return (
    <div data-part="tool-blocks">
      {blocks.map((block, index) => {
        const Block = own(defaultBlocks, block.type) ?? UnknownBlock;
        return <Block key={index} block={block} id={`${id}:block-${index}`} streaming={false} />;
      })}
    </div>
  );
}
