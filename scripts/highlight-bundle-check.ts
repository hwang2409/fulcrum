import { readdir } from "node:fs/promises";

const root = new URL("../packages/highlight/dist/", import.meta.url);
const controller = await Bun.file(new URL("index.js", root)).text();
const worker = await Bun.file(new URL("worker.js", root)).text();
for (const output of [controller, worker]) {
  if (output.includes("source.csharp") || output.includes("source.typescript") || output.includes("@shikijs/langs"))
    throw new Error("highlight grammar code was bundled into the controller or worker entry");
}
const grammars = (await readdir(new URL("langs/", root))).filter((name) => name.endsWith(".js"));
if (grammars.length < 200) throw new Error(`expected the generated Shiki registry chunks, found ${grammars.length}`);
console.log(`highlight bundle check passed: ${grammars.length} lazy grammar chunks, controller and worker contain no grammar code`);
