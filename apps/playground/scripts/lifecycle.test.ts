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

  test("a child that already exited gets no signal", async () => {
    const { child, signals } = fakeChild([]);
    child.exitCode = 0;
    await stopChild("vite", child, 30);
    expect(signals).toEqual([]);
  });
});
