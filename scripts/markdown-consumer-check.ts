import { mkdir, readdir, rm, writeFile } from "node:fs/promises";

const root = new URL("../.markdown-consumer/", import.meta.url);
const markdownDir = new URL("../packages/markdown/", import.meta.url);
const highlightDir = new URL("../packages/highlight/", import.meta.url);
const run = (command: string[], cwd: URL) => {
  const result = Bun.spawnSync(command, { cwd: cwd.pathname, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} exited ${result.exitCode}`);
};

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
try {
  run(["bun", "run", "build"], highlightDir);
  run(["bun", "run", "build"], markdownDir);
  run(["bun", "pm", "pack", "--destination", root.pathname, "--quiet"], highlightDir);
  run(["bun", "pm", "pack", "--destination", root.pathname, "--quiet"], markdownDir);
  const tarballs = await readdir(root);
  const highlight = tarballs.find((file) => file.startsWith("fulcrum-highlight-") && file.endsWith(".tgz"));
  const markdown = tarballs.find((file) => file.startsWith("fulcrum-markdown-") && file.endsWith(".tgz"));
  if (!highlight || !markdown) throw new Error("bun pm pack did not create both tarballs");
  await writeFile(new URL("package.json", root), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@fulcrum/highlight": `file:./${highlight}`,
      "@fulcrum/markdown": `file:./${markdown}`,
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
if (parsed[0]?.type !== "heading" || !html.includes("<strong")) throw new Error("packed markdown imports failed");
console.log("packed markdown imports passed");
`);
  run(["bun", "install"], root);
  run(["bun", "check.mjs"], root);
} finally {
  await rm(root, { recursive: true, force: true });
}
