import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { closeBrowser, stopChild, withDeadline } from "./lifecycle";

const never = () => new Promise<never>(() => {});

/** A spawned child that ignores the signals in `ignore` and exits on any other. */
function fakeChild(ignore: NodeJS.Signals[]) {
  const signals: NodeJS.Signals[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      if (!ignore.includes(signal)) setTimeout(() => { child.signalCode = signal; child.emit("exit"); }, 1);
    },
  });
  return { child, signals };
}

describe("lifecycle", () => {
  test("a browser close that never settles rejects by name within the bound and kills the recorded pid", async () => {
    const killed: [number, string][] = [];
    const started = performance.now();
    const error = await closeBrowser("large-blocks cleanup: browser.close", never, 777, 50, (pid, signal) => killed.push([pid, signal])).catch((caught: Error) => caught);
    expect(String(error)).toContain("large-blocks cleanup: browser.close timed out after 0.05 s");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(killed).toEqual([[777, "SIGKILL"]]);
  });

  test("a browser close that settles in time kills nothing", async () => {
    const killed: number[] = [];
    await closeBrowser("close", async () => {}, 777, 50, (pid) => killed.push(pid));
    expect(killed).toEqual([]);
  });

  test("a failing timeout action still rejects with the named timeout", async () => {
    const error = await withDeadline("op", 20, never(), () => { throw new Error("ESRCH"); }).catch((caught: Error) => caught);
    expect(String(error)).toContain("op timed out after 0.02 s (and the timeout action failed: Error: ESRCH)");
  });

  test("a child that ignores SIGTERM gets SIGKILL after the grace period", async () => {
    const { child, signals } = fakeChild(["SIGTERM"]);
    await stopChild("vite", child, 30);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a child that ignores every signal rejects by name within the bound", async () => {
    const { child, signals } = fakeChild(["SIGTERM", "SIGKILL"]);
    const started = performance.now();
    const error = await stopChild("vite", child, 30).catch((caught: Error) => caught);
    expect(String(error)).toContain("vite SIGKILL timed out after 0.03 s");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  for (const pid of [0, -1, 1.5]) {
    test(`a browser close that times out with pid ${pid} kills nothing and says no valid pid was available`, async () => {
      const killed: number[] = [];
      const error = await closeBrowser("browser.close", never, pid, 20, (target) => killed.push(target)).catch((caught: Error) => caught);
      expect(killed).toEqual([]);
      expect(String(error)).toContain("browser.close timed out after 0.02 s");
      expect(String(error)).toContain("no valid browser pid");
    });
  }

  for (const pid of [0, -1, undefined]) {
    test(`a child with pid ${pid} gets no signal and rejects by name`, async () => {
      const { child, signals } = fakeChild([]);
      Object.assign(child, { pid });
      const error = await stopChild("vite", child, 30).catch((caught: Error) => caught);
      expect(signals).toEqual([]);
      expect(String(error)).toContain(`vite: no valid pid (${pid}), nothing signalled`);
    });
  }

  test("a child that already exited gets no signal", async () => {
    const { child, signals } = fakeChild([]);
    child.exitCode = 0;
    await stopChild("vite", child, 30);
    expect(signals).toEqual([]);
  });
});
