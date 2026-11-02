import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const root = new URL("../.highlight-consumer/", import.meta.url);
const packageDir = new URL("../packages/highlight/", import.meta.url);
const run = (command: string[], cwd: URL) => {
  const result = Bun.spawnSync(command, { cwd: cwd.pathname, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} exited ${result.exitCode}`);
};

await rm(root, { recursive: true, force: true });
await mkdir(new URL("src/", root), { recursive: true });
try {
  run(["bun", "run", "build"], packageDir);
  run(["bun", "pm", "pack", "--destination", root.pathname, "--quiet"], packageDir);
  const tarball = (await readdir(root)).find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error("bun pm pack did not create a tarball");
  await writeFile(new URL("package.json", root), JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@fulcrum/highlight": `file:./${tarball}`, vite: "8.3.5" },
    scripts: { build: "vite build" },
  }));
  await writeFile(new URL("index.html", root), '<script type="module" src="/src/main.ts"></script>\n');
  await writeFile(new URL("src/main.ts", root), 'import { createHighlighter } from "@fulcrum/highlight";\nconst highlight = createHighlighter();\nvoid highlight("const value: number = 1;\\n", "typescript", { id: "check", version: 1, state: "done" });\n');
  run(["bun", "install"], root);
  run(["bun", "run", "build"], root);

  const assets = new URL("dist/assets/", root);
  const files = await readdir(assets);
  const javascript = await Promise.all(files.filter((file) => file.endsWith(".js")).map(async (file) => ({ file, data: await readFile(new URL(file, assets)) })));
  const worker = javascript.find(({ file }) => file.startsWith("worker-"));
  if (!worker) throw new Error("consumer build did not emit a worker chunk");
  if (worker.data.includes(Buffer.from('"displayName":"TypeScript"')) || worker.data.includes(Buffer.from('"displayName":"Python"')))
    throw new Error("initial worker chunk contains a bundled grammar");
  if (worker.data.byteLength > 750_000) throw new Error(`initial worker chunk is ${worker.data.byteLength} bytes; ceiling is 750000`);
  const grammar = javascript.find(({ file }) => file.startsWith("typescript-"));
  if (!grammar) throw new Error("consumer build did not emit typescript as a separate grammar asset");
  console.log(`highlight consumer worker\t${worker.data.byteLength} b\t${gzipSync(worker.data).byteLength} b gzip\t${worker.file}`);
  console.log(`highlight consumer typescript grammar\t${grammar.data.byteLength} b\t${gzipSync(grammar.data).byteLength} b gzip\t${grammar.file}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
