import type { ComponentType } from "react";
import type { ToolCall } from "@fulcrum/core";
import type { ToolBodyProps, ToolItem } from "../parts.js";
import { diffStatText } from "./diff.js";
import { EditBody } from "./edit.js";
import { FetchBody } from "./fetch.js";
import { GenericBody } from "./generic.js";
import { ReadBody } from "./read.js";
import { SearchBody } from "./search.js";
import { ShellBody } from "./shell.js";
import { WriteBody } from "./write.js";
import { argumentSummary } from "./argument-summary.js";
import { lineCount, sourceText } from "./common.js";

export { EditBody, FetchBody, GenericBody, ReadBody, SearchBody, ShellBody, WriteBody };

const bodies: Record<NonNullable<ToolItem["view"]>["kind"], ComponentType<ToolBodyProps>> = {
  shell: ShellBody,
  read: ReadBody,
  edit: EditBody,
  write: WriteBody,
  search: SearchBody,
  fetch: FetchBody,
};

/** The default body of ToolCall and Approval: the card for the item's view kind, or the generic one with no view. */
export function ToolBody(props: ToolBodyProps) {
  const Body = (props.item.view && bodies[props.item.view.kind]) || GenericBody;
  return <Body {...props} />;
}

export { argumentSummary };

/** The default one-line header summary: `$ ls`, `src/a.ts:1-40`, `src/a.ts +3 -1`, `"TODO" packages/`, `example.com/a`. */
export function toolSummary({ view, tool_call }: ToolItem): string {
  switch (view?.kind) {
    case "shell":
      return `$ ${view.command}`;
    case "read": {
      const start = (view.range?.offset ?? 0) + 1;
      const limit = view.range?.limit;
      return limit !== undefined ? `${view.path}:${start}-${start + limit - 1}` : view.range?.offset ? `${view.path}:${start}` : view.path;
    }
    case "edit": {
      if (view.diff.omission) return view.path; // counts over a diff that was not all kept would be wrong
      const { insert, remove } = diffStatText(sourceText(view.diff));
      return `${view.path} +${insert} -${remove}`;
    }
    case "write":
      return view.content !== undefined ? `${view.path} +${view.content.lines}` : view.path;
    case "search":
      return view.path ? `"${view.pattern}" ${view.path}` : `"${view.pattern}"`;
    case "fetch":
      return view.url !== undefined ? view.url.replace(/^https?:\/\//, "") : view.query;
  }
  const { count, text } = argumentSummary(tool_call);
  return count ? `${count} · ${text}` : text;
}
