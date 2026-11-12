// internal: no API promise; for @fulcrum/* packages only. index.ts and this entry import the same stream.js, so the
// chains the public reducer builds are the ones streamTail reads.
export { streamTail } from "./stream.js";
export { sourceTail, storeToolView } from "./text-source.js";
