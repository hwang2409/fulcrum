import { afterAll, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const sourcePackageDir = join(import.meta.dir, "..");
const sourceRoot = resolve(sourcePackageDir, "../..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "fulcrum-highlight-build-race-"));
const packageDir = join(temporaryRoot, "packages/highlight");
const dist = join(packageDir, "dist");
const children: Bun.Subprocess[] = [];

await cp(sourcePackageDir, packageDir, {
  recursive: true,
  filter: (source) => basename(source) !== "node_modules",
});
await cp(join(sourceRoot, "bun.lock"), join(temporaryRoot, "bun.lock"));
await symlink(join(sourceRoot, "node_modules"), join(temporaryRoot, "node_modules"));

afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill();
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function containsTemporaryBuildPath(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsTemporaryBuildPath(path)) return true;
    } else if ((await readFile(path)).includes("dist.tmp-")) return true;
  }
  return false;
}

test("concurrent package builds keep a complete path-independent dist", { timeout: 30_000 }, async () => {
  const sourceWorkerInode = (await stat(join(sourcePackageDir, "dist/worker.js"))).ino;
  const builds = [0, 1].map(() => {
    const child = Bun.spawn(["bun", "run", "build"], { cwd: packageDir, stdout: "ignore", stderr: "pipe" });
    children.push(child);
    return child;
  });
  const reads = (async () => {
    while (builds.some((build) => build.exitCode === null)) {
      const files = await readdir(dist).catch(() => []);
      if (files.length) await readFile(join(dist, "worker.js")).catch(() => undefined);
    }
  })();
  const results = await Promise.all(builds.map(async (build) => ({ code: await build.exited, error: await new Response(build.stderr).text() })));
  await reads;
  expect(results.map(({ code }) => code)).toEqual([0, 0]);
  expect(results.map(({ error }) => error).join("\n")).not.toContain("No such file or directory");
  expect(await containsTemporaryBuildPath(dist)).toBe(false);
  expect((await stat(join(sourcePackageDir, "dist/worker.js"))).ino).toBe(sourceWorkerInode);
});
