import { afterAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packageDir = join(import.meta.dir, "..");
const dist = join(packageDir, "dist");
const children: Bun.Subprocess[] = [];

afterAll(() => Promise.all(children.map((child) => child.kill())));

test("concurrent package builds keep a complete dist", { timeout: 30_000 }, async () => {
  const baseline = Bun.spawnSync(["bun", "run", "build"], { cwd: packageDir, stdout: "ignore", stderr: "inherit" });
  expect(baseline.exitCode).toBe(0);
  const builds = [0, 1].map(() => {
    const child = Bun.spawn(["bun", "run", "build"], { cwd: packageDir, stdout: "pipe", stderr: "pipe" });
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
});
