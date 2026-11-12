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

// shortcut: the first string argument is the most telling one for common tools (command, path, pattern, url); adapters that set a view do better.
const LABEL_KEYS = ["content", "title", "text", "name"];
// An object's label: its content, title, text, or name, else its first string field.
const labelOf = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const key = LABEL_KEYS.find((name) => typeof record[name] === "string");
  return key ? record[key] as string : Object.values(record).find((field): field is string => typeof field === "string");
};

/**
 * A generic tool's summary: its first string argument, else its first list as "N items" and the first item's label
 * (a todo list reads `1 item · cap the pending queue`), else its arguments as JSON.
 */
export function argumentSummary(call: ToolCall): { count?: string; text: string } {
  const args = call.arguments ?? {};
  const values = Object.values(args);
  const first = values.find((value) => typeof value === "string");
  if (typeof first === "string") return { text: first };
  const list = values.find((value): value is unknown[] => Array.isArray(value) && value.length > 0);
  if (list) return { count: `${list.length} ${list.length === 1 ? "item" : "items"}`, text: labelOf(list[0]) ?? JSON.stringify(list[0]) };
  return { text: Object.keys(args).length ? JSON.stringify(args) : "" };
}
const firstArgument = (call: ToolCall) => {
  const { count, text } = argumentSummary(call);
  return count ? `${count} · ${text}` : text;
};

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
  return firstArgument(tool_call);
}
