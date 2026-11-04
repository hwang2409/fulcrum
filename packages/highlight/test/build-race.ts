import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyBuildManifest } from "../src/generation-cache.js";

const sourcePackageDir = join(import.meta.dir, "..");
const sourceRoot = resolve(sourcePackageDir, "../..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "fulcrum-highlight-build-race-"));
const packageDir = join(temporaryRoot, "packages/highlight");
const dist = join(packageDir, "dist");
const children: Bun.Subprocess[] = [];

await cp(sourcePackageDir, packageDir, {
  recursive: true,
  filter: (source) => !["dist", "node_modules", ".build.lock"].includes(basename(source)),
});
await cp(join(sourceRoot, "bun.lock"), join(temporaryRoot, "bun.lock"));
await symlink(join(sourceRoot, "node_modules"), join(temporaryRoot, "node_modules"));

afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill();
  await rm(temporaryRoot, { recursive: true, force: true });
});

const runBuild = () => {
  const child = Bun.spawn(["bun", "run", "build"], { cwd: packageDir, stdout: "ignore", stderr: "pipe" });
  children.push(child);
  return child;
};

const buildResult = async (child: Bun.Subprocess) => ({ code: await child.exited, error: await new Response(child.stderr).text() });

async function expectValidDist() {
  expect(await verifyBuildManifest(pathToFileURL(`${dist}/`))).toBe(true);
  const manifest = JSON.parse(await readFile(join(dist, ".build-manifest.json"), "utf8")) as { files: Record<string, string> };
  expect(Object.keys(manifest.files)).toContain("worker.js");
  expect(Object.keys(manifest.files).filter((path) => path.startsWith("langs/") && path.endsWith(".js"))).toHaveLength(241);
  expect(Object.keys(manifest.files).filter((path) => path.startsWith("recipes/") && path.endsWith(".js"))).toHaveLength(241);
}

describe.serial("package build lock", () => {
  test("concurrent package builds produce one verified dist", { timeout: 120_000 }, async () => {
    const results = await Promise.all([runBuild(), runBuild(), runBuild()].map(buildResult));
    expect(results.map(({ code }) => code)).toEqual([0, 0, 0]);
    expect(results.map(({ error }) => error).join("\n")).not.toContain("No such file or directory");
    await expectValidDist();
    const workerPath = join(dist, "worker.js");
    const worker = await readFile(workerPath);
    await writeFile(workerPath, worker.subarray(0, worker.length - 1));
    expect(await verifyBuildManifest(pathToFileURL(`${dist}/`))).toBe(false);
    await writeFile(workerPath, worker);
    await expectValidDist();
  });

  test("takes over a stale lock owned by a dead process", { timeout: 60_000 }, async () => {
    const deadPid = 2_147_483_647;
    expect(() => process.kill(deadPid, 0)).toThrow();
    await writeFile(join(packageDir, ".build.lock"), JSON.stringify({ pid: deadPid, startedAt: "2000-01-01T00:00:00.000Z" }));
    const result = await buildResult(runBuild());
    expect(result.code).toBe(0);
    expect(result.error).not.toContain("No such file or directory");
    await expectValidDist();
  });
});
