import { readFile } from "node:fs/promises";

// Every package bundled into a published dist (read from its source maps) is named in that package's notices.
const root = new URL("../", import.meta.url);
for (const name of ["highlight", "mermaid"]) {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: new URL(`packages/${name}/`, root).pathname, stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) process.exit(build.exitCode);
  const notices = await readFile(new URL(`packages/${name}/THIRD_PARTY_NOTICES.md`, root), "utf8");
  const packages = new Set<string>();
  for await (const file of new Bun.Glob("**/*.js.map").scan(new URL(`packages/${name}/dist/`, root).pathname)) {
    const map = JSON.parse(await readFile(new URL(`packages/${name}/dist/${file}`, root), "utf8")) as { sources?: string[] };
    for (const source of map.sources ?? []) {
      const dependency = source.split("/node_modules/").at(-1);
      if (!dependency || dependency.startsWith(".") || dependency === source) continue;
      const parts = dependency.split("/");
      packages.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
    }
  }
  // the project itself may be named without backticks, as the notices' first row does
  const missing = [...packages].filter((dependency) => !notices.includes(`\`${dependency}\``) && !(dependency === name || notices.includes(`| ${dependency} |`) || notices.includes(`| ${dependency},`))).sort();
  if (missing.length) throw new Error(`@fulcrum/${name}: missing third-party notices: ${missing.join(", ")}`);
  console.log(`@fulcrum/${name}: third-party notices cover ${packages.size} bundled packages`);
}
