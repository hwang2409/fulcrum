import { readFileSync } from "node:fs";
import { eventTypes } from "../src/event-types.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run check:zeta-events <path-to-event_contract.py>");
  process.exit(2);
}

const source = readFileSync(path, "utf8");
const block = (name: string) => {
  const match = source.match(new RegExp(`${name} = \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`could not find ${name} in ${path}`);
  return match[1];
};
const values = (sourceBlock: string) =>
  [...sourceBlock.matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1]);
const legacy = source.match(/LEGACY_NOTIFICATION_WIRE_EVENT\s*=\s*"([^"]+)"/)?.[1];
if (!legacy) throw new Error(`could not find LEGACY_NOTIFICATION_WIRE_EVENT in ${path}`);

const authority = new Set([
  legacy,
  ...values(block("NOTIFICATION_WIRE_EVENTS")),
  ...values(block("AUXILIARY_WIRE_EVENTS")),
  ...values(block("STREAM_EVENT_WIRE_EVENTS")),
]);
const copied = new Set(Object.keys(eventTypes));
const missing = [...authority].filter((event) => !copied.has(event));
const extra = [...copied].filter((event) => !authority.has(event));
if (missing.length || extra.length) {
  if (missing.length) console.error(`missing copied events: ${missing.join(", ")}`);
  if (extra.length) console.error(`events absent from authority: ${extra.join(", ")}`);
  process.exit(1);
}
console.log(`${copied.size} zeta events match ${path}`);
