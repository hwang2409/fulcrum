import { languageForContentType, languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, boundText, bytes, Empty, Foot, Output } from "./common.js";

// The body's language: the Content-Type's when it names one, else the url path's extension (`/data.json`), else none.
const bodyLanguage = (url: string | undefined, contentType: string | undefined) => {
  const typed = contentType ? languageForContentType(contentType) : undefined;
  if (typed) return typed;
  try {
    return url ? languageForPath(new URL(url).pathname) : undefined;
  } catch {
    return undefined;
  }
};

export function FetchBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "fetch") return null;
  const { url, query, status, title, bytes: size, contentType } = item.view;
  return (
    <>
      <div data-part="fetch-meta">
        {status !== undefined ? <span data-part="fetch-status" data-status-class={`${String(status)[0]}xx`}>HTTP {status}</span> : null}
        {url !== undefined ? <span data-part="fetch-url">{boundText(url).text}</span> : <span data-part="fetch-query">{boundText(query).text}</span>}
        {contentType ? <span data-part="fetch-type">{boundText(contentType.split(";")[0]!, 80).text}</span> : null}
        {title ? <span data-part="fetch-title">{boundText(title).text}</span> : null}
      </div>
      {output ? <Output text={output} id={`${item.id}:body`} done={state !== "streaming"} language={bodyLanguage(url, contentType)} pretty follow={false} /> : <Empty state={state} noun="response" />}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[url !== undefined ? ["url", url] : ["query", query], ["output", output]]}>
        {size !== undefined ? <span data-part="tool-size">{bytes(size)}</span> : null}
      </Foot>
    </>
  );
}
