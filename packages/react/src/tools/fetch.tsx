import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, bytes, Empty, Foot, Output } from "./common.js";

export function FetchBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "fetch") return null;
  const { url, query, status, title, bytes: size } = item.view;
  return (
    <>
      <div data-part="fetch-meta">
        {status !== undefined ? <span data-part="fetch-status" data-ok={status < 400 || undefined}>HTTP {status}</span> : null}
        {url !== undefined ? <span data-part="fetch-url">{url}</span> : <span data-part="fetch-query">{query}</span>}
        {title ? <span data-part="fetch-title">{title}</span> : null}
      </div>
      {output ? <Output text={output} /> : <Empty state={state} noun="response" />}
      {asking(state) ? <Arguments call={item.tool_call} /> : null}
      <Foot copy={[url !== undefined ? ["url", url] : ["query", query], ["output", output]]}>
        {size !== undefined ? <span data-part="tool-size">{bytes(size)}</span> : null}
      </Foot>
    </>
  );
}
