// Run in a child process by memory.test.ts, because a heap snapshot leaves JSC slower for the rest of the process.
// Streams `appends` deltas of `size` characters into one message from empty and reads the text, from heap snapshots:
// - default: reads after each append, as a renderer does, and prints the rope (engine concatenation) nodes alive
//   afterwards per append (a rope is a string cell with edges to its parts) and the characters joined
//   (Array.prototype.join) per added one.
// - `held`: reads after every third append, flattens the text (`at(-1)`) and keeps the row, as a renderer that keeps
//   every snapshot it drew (#99), and prints the bytes of all strings alive afterwards per byte of final text.
import { generateHeapSnapshot } from "bun";
import { createRunStore, type RunItem } from "../src/index.js";

type Snapshot = { nodes: number[]; nodeClassNames: string[]; edges: number[] };
// Node fields: id, size, class name index, flags.
function strings() {
  const { nodes, nodeClassNames, edges } = generateHeapSnapshot() as unknown as Snapshot;
  const ids = new Set<number>();
  let bytes = 0;
  for (let at = 0; at < nodes.length; at += 4) {
    if (nodeClassNames[nodes[at + 2]!] !== "string") continue;
    ids.add(nodes[at]!);
    bytes += nodes[at + 1]!;
  }
  const ropes = new Set<number>();
  for (let at = 0; at < edges.length; at += 4) if (ids.has(edges[at]!) && ids.has(edges[at + 1]!)) ropes.add(edges[at]!);
  return { ropes: ropes.size, bytes };
}

const [appendsArg, sizeArg, mode] = process.argv.slice(2);
const appends = Number(appendsArg);
const size = Number(sizeArg);
const held: RunItem[] | undefined = mode === "held" ? [] : undefined;
const store = createRunStore((job) => job());
const message = () => store.getItem("message:m") as Extract<RunItem, { type: "message" }>;
const join = Array.prototype.join;
let joined = 0;
Array.prototype.join = function (this: unknown[], separator?: string) {
  const result = join.call(this, separator);
  joined += result.length;
  return result;
};
const before = strings();
for (let index = 0; index < appends; index++) {
  // A distinct flat string per delta, as parsed wire events are.
  store.dispatch({ type: "message_delta", message_id: "m", delta: JSON.parse(`"${String(index).padStart(size, "x")}"`) });
  if (held && (index + 1) % 3 !== 0) continue;
  const item = message();
  if (item.text.length !== (index + 1) * size) throw new Error("a read did not include every delta");
  if (!held) continue;
  if (item.text.at(-1) !== String(index).at(-1)) throw new Error("a read did not end with the last delta");
  held.push(item);
}
Array.prototype.join = join;
const after = strings();
// A sample: each older read joins its whole chain.
for (let at = 0; held && at < held.length; at += 500) if (held[at]!.text !== message().text.slice(0, (at + 1) * 3 * size)) throw new Error("a held snapshot lost its text");
console.log(
  JSON.stringify({
    ropesPerAppend: (after.ropes - before.ropes) / appends,
    joinedPerChar: joined / (appends * size),
    stringBytesPerChar: (after.bytes - before.bytes) / (appends * size),
  }),
);
