// Bounded cleanup for browser scripts: every wait has a deadline, and a stuck resource is killed by its own pid, so a
// hang ends with a named error instead of holding the CI runner.

/** Waits for `operation`; after `ms` it calls `onTimeout` and rejects with `<name> timed out after <s> s`. */
export async function withDeadline<T>(name: string, ms: number, operation: Promise<T>, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      let note = "";
      try { onTimeout?.(); } catch (error) { note = ` (and the timeout action failed: ${error})`; }
      reject(new Error(`${name} timed out after ${ms / 1000} s${note}`));
    }, ms);
  });
  try { return await Promise.race([operation, expired]); }
  finally { clearTimeout(timer); }
}

/** Runs `close` (pages, contexts, then the browser) within `ms`; on timeout, SIGKILLs the browser process `pid`. */
export function closeBrowser(name: string, close: () => Promise<unknown>, pid: number | undefined, ms = 10_000, kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill) {
  return withDeadline(name, ms, close(), () => { if (pid !== undefined) kill(pid, "SIGKILL"); });
}

type Child = { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal: NodeJS.Signals): unknown; once(event: "exit", listener: () => void): unknown };

/** Stops a spawned child: SIGTERM, then SIGKILL after `graceMs`, then rejects if it is still alive after `graceMs` more. */
export async function stopChild(name: string, child: Child, graceMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", resolve)); // listen before the first signal
  child.kill("SIGTERM");
  try { await withDeadline(`${name} SIGTERM`, graceMs, exited); return; } catch {}
  child.kill("SIGKILL");
  await withDeadline(`${name} SIGKILL`, graceMs, exited);
}
