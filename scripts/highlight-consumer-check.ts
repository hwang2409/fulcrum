import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const root = new URL("../.highlight-consumer/", import.meta.url);
const packageDir = new URL("../packages/highlight/", import.meta.url);
const reactRoot = new URL("../.react-consumer/", import.meta.url);
const grammarFiles = new Set(["typescript", "tsx", "javascript", "jsx", "python", "shellscript", "json", "diff", "rust", "go", "sql", "yaml", "css", "html", "markdown", "toml", "dockerfile", "c", "cpp", "java", "kotlin", "swift", "ruby", "php", "lua", "make", "ini", "xml", "graphql", "proto"]);
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
  const typescript = javascript.filter(({ file }) => file.startsWith("typescript-"));
  const grammar = typescript.find(({ data }) => data.includes(Buffer.from('"displayName":"TypeScript"')));
  const recipe = typescript.find(({ data }) => !data.includes(Buffer.from('"displayName":"TypeScript"')));
  if (!grammar || !recipe) throw new Error("consumer build did not emit separate typescript grammar and recipe assets");
  if (worker.data.includes(Buffer.from("source.ts"))) throw new Error("initial worker chunk contains a regex recipe");
  console.log(`highlight consumer worker\t${worker.data.byteLength} b\t${gzipSync(worker.data).byteLength} b gzip\t${worker.file}`);
  console.log(`highlight consumer typescript grammar\t${grammar.data.byteLength} b\t${gzipSync(grammar.data).byteLength} b gzip\t${grammar.file}`);
  console.log(`highlight consumer typescript recipe\t${recipe.data.byteLength} b\t${gzipSync(recipe.data).byteLength} b gzip\t${recipe.file}`);

  // A @fulcrum/react app with no highlighter ships neither the worker nor a grammar: react resolves language names
  // through @fulcrum/highlight/languages, which imports no grammar or worker url.
  await rm(reactRoot, { recursive: true, force: true });
  await mkdir(new URL("src/", reactRoot), { recursive: true });
  const tarballs: Record<string, string> = { "@fulcrum/highlight": new URL(tarball, root).pathname };
  for (const name of ["core", "virtual", "react"]) {
    const dir = new URL(`../packages/${name}/`, import.meta.url);
    run(["bun", "run", "build"], dir);
    run(["bun", "pm", "pack", "--destination", reactRoot.pathname, "--quiet"], dir);
    tarballs[`@fulcrum/${name}`] = new URL((await readdir(reactRoot)).find((file) => file.startsWith(`fulcrum-${name}-`))!, reactRoot).pathname;
  }
  await writeFile(new URL("package.json", reactRoot), JSON.stringify({
    private: true,
    type: "module",
    dependencies: { ...Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`])), react: "^19", "react-dom": "^19", vite: "8.3.5" },
    scripts: { build: "vite build" },
  }));
  await writeFile(new URL("index.html", reactRoot), '<div id="root"></div><script type="module" src="/src/main.ts"></script>\n');
  await writeFile(new URL("src/main.ts", reactRoot), [
    'import { createElement } from "react";',
    'import { createRoot } from "react-dom/client";',
    'import { createRunStore } from "@fulcrum/core";',
    'import { RunProvider, Timeline } from "@fulcrum/react";',
    "const store = createRunStore(() => {});",
    'createRoot(document.getElementById("root")!).render(createElement(RunProvider, { store }, createElement(Timeline)));',
    "",
  ].join("\n"));
  // npm resolves @fulcrum/react's peers to the packed tarballs; bun install would look them up on the registry.
  run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], reactRoot);
  run(["npm", "run", "build"], reactRoot);
  const emitted = await readdir(new URL("dist/assets/", reactRoot));
  const heavy = emitted.filter((file) => /^(worker|runtime)-/.test(file) || grammarFiles.has(file.replace(/-[\w-]{8}\.js$/, "")));
  if (heavy.length) throw new Error(`a @fulcrum/react consumer with no highlighter emitted the worker or grammars: ${heavy.join(", ")}`);
  console.log(`react consumer without a highlighter\t${emitted.length} assets\t${emitted.join(", ")}`);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(reactRoot, { recursive: true, force: true });
}
