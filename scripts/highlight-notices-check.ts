import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const build = Bun.spawnSync(["bun", "run", "build"], { cwd: new URL("packages/highlight/", root).pathname, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode);
const notices = await readFile(new URL("packages/highlight/THIRD_PARTY_NOTICES.md", root), "utf8");
const packages = new Set<string>();
for await (const file of new Bun.Glob("**/*.js.map").scan(new URL("packages/highlight/dist/", root).pathname)) {
  const map = JSON.parse(await readFile(new URL(`packages/highlight/dist/${file}`, root), "utf8")) as { sources?: string[] };
  for (const source of map.sources ?? []) {
    const dependency = source.split("/node_modules/").at(-1);
    if (!dependency || dependency.startsWith(".")) continue;
    const parts = dependency.split("/");
    packages.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
}
const missing = [...packages].filter((name) => !notices.includes(`\`${name}\``)).sort();
if (missing.length) throw new Error(`missing third-party notices: ${missing.join(", ")}`);
console.log(`third-party notices cover ${packages.size} bundled packages`);
