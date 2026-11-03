import { mkdir, readdir, rm, writeFile } from "node:fs/promises";

const root = new URL("../.markdown-consumer/", import.meta.url);
const markdownDir = new URL("../packages/markdown/", import.meta.url);
const highlightDir = new URL("../packages/highlight/", import.meta.url);
// markdown draws a large code block with @fulcrum/react's shared code viewer; @fulcrum/react's peers come along.
const reactDir = new URL("../packages/react/", import.meta.url);
const coreDir = new URL("../packages/core/", import.meta.url);
const virtualDir = new URL("../packages/virtual/", import.meta.url);
const run = (command: string[], cwd: URL) => {
  const result = Bun.spawnSync(command, { cwd: cwd.pathname, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} exited ${result.exitCode}`);
};

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
try {
  run(["bun", "run", "build"], highlightDir);
  for (const dir of [coreDir, virtualDir, reactDir, markdownDir]) run(["bun", "run", "build"], dir);
  for (const dir of [highlightDir, coreDir, virtualDir, reactDir, markdownDir]) run(["bun", "pm", "pack", "--destination", root.pathname, "--quiet"], dir);
  const tarballs = await readdir(root);
  const tarball = (name: string) => {
    const file = tarballs.find((file) => file.startsWith(`fulcrum-${name}-`) && file.endsWith(".tgz"));
    if (!file) throw new Error(`bun pm pack did not create the ${name} tarball`);
    return file;
  };
  const [highlight, core, virtual, react, markdown] = ["highlight", "core", "virtual", "react", "markdown"].map(tarball);
  await writeFile(new URL("package.json", root), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@fulcrum/highlight": `file:./${highlight}`,
      "@fulcrum/markdown": `file:./${markdown}`,
      "@fulcrum/core": `file:./${core}`,
      "@fulcrum/react": `file:./${react}`,
      "@fulcrum/virtual": `file:./${virtual}`,
      react: "19.3.1",
      "react-dom": "19.3.1",
    },
  }));
  await writeFile(new URL("check.mjs", root), `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseMarkdown } from "@fulcrum/markdown";
import { Markdown } from "@fulcrum/markdown/react";
const parsed = parseMarkdown("# packed");
const html = renderToStaticMarkup(React.createElement(Markdown, { source: "**works**" }));
const large = renderToStaticMarkup(React.createElement(Markdown, { source: "\`\`\`ts\\n" + "x\\n".repeat(500) + "\`\`\`\\n" }));
if (parsed[0]?.type !== "heading" || !html.includes("<strong") || !large.includes('data-size="large"')) throw new Error("packed markdown imports failed");
console.log("packed markdown imports passed");
`);
  run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], root); // bun looks for the tarballs' peers in the registry
  run(["bun", "check.mjs"], root);
} finally {
  await rm(root, { recursive: true, force: true });
}
