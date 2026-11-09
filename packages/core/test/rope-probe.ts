// Run in a child process by memory.test.ts, because a heap snapshot leaves JSC slower for the rest of the process.
// Streams `appends` deltas of `size` characters into one message from empty, reading the text after each as a renderer
// does, and prints the rope (engine concatenation) nodes alive afterwards per append, from a heap snapshot: a rope is
// a string cell with edges to its parts. It also prints the characters joined (Array.prototype.join) per added one.
import { generateHeapSnapshot } from "bun";
import { createRunStore, type RunItem } from "../src/index.js";

type Snapshot = { nodes: number[]; nodeClassNames: string[]; edges: number[] };
function ropes() {
  const { nodes, nodeClassNames, edges } = generateHeapSnapshot() as unknown as Snapshot;
  const strings = new Set<number>();
  for (let at = 0; at < nodes.length; at += 4) if (nodeClassNames[nodes[at + 2]!] === "string") strings.add(nodes[at]!);
  const found = new Set<number>();
  for (let at = 0; at < edges.length; at += 4) if (strings.has(edges[at]!) && strings.has(edges[at + 1]!)) found.add(edges[at]!);
  return found.size;
}

const [appends, size] = process.argv.slice(2).map(Number) as [number, number];
const store = createRunStore((job) => job());
const text = () => (store.getItem("message:m") as Extract<RunItem, { type: "message" }>).text;
const join = Array.prototype.join;
let joined = 0;
Array.prototype.join = function (this: unknown[], separator?: string) {
  const result = join.call(this, separator);
  joined += result.length;
  return result;
};
const before = ropes();
for (let index = 0; index < appends; index++) {
  // A distinct flat string per delta, as parsed wire events are.
  store.dispatch({ type: "message_delta", message_id: "m", delta: JSON.parse(`"${String(index).padStart(size, "x")}"`) });
  if (text().length !== (index + 1) * size) throw new Error("a read did not include every delta");
}
Array.prototype.join = join;
console.log(JSON.stringify({ ropesPerAppend: (ropes() - before) / appends, joinedPerChar: joined / (appends * size) }));
