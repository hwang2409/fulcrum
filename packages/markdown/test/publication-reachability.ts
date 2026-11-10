import { expect } from "bun:test";
import type { Block, Inline } from "../src/index.js";

const childLists = (block: Block): readonly (readonly Inline[])[] => block.type === "paragraph" || block.type === "heading" ? [block.children]
  : block.type === "blockquote" ? block.children.flatMap(childLists)
    : block.type === "list" ? block.items.flatMap((item) => item.children.flatMap(childLists))
      : block.type === "table" ? [...block.header, ...block.rows.flat()]
        : [];

/** A visible inline cell must have exactly one incoming publication link. */
export function expectSinglePublicationLocation(blocks: readonly Block[], label: string) {
  const incoming = new Map<Inline, string>();
  const visit = (nodes: readonly Inline[], parent: string) => {
    nodes.forEach((node, index) => {
      const path = `${parent}[${index}]`;
      const previous = incoming.get(node);
      expect(previous, `${label}: duplicate publication link ${previous ?? ""} -> ${path}`).toBeUndefined();
      incoming.set(node, path);
      if ("children" in node) visit(node.children, `${path}.children`);
    });
  };
  blocks.flatMap(childLists).forEach((nodes, index) => visit(nodes, `root[${index}]`));
}
