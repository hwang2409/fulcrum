import { useCallback, useEffect, useState } from "react";
import type { RunPathChange } from "./run-navigation.js";

// Each history entry this hook writes records its path and how many entries in a row behind it this hook pushed, one
// level each. Back steps over only those; anything else (a deep link, someone else's entry) is replaced in place.
const STATE = "fulcrumRunPath";
type Saved = { readonly path: readonly string[]; readonly pushed: number; readonly entry?: string };
// Where the Navigation API exists, each entry has a key, so an entry someone pushed with a copy of our state is not ours.
const entryKey = () => (globalThis as { navigation?: { currentEntry?: { key: string } | null } }).navigation?.currentEntry?.key;

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
// Mounted hooks by key. Unmount cleanup waits a tick and runs only if no hook with the key mounted again meanwhile
// (a keyed remount, or React strict mode), so it never undoes the path of the hook that replaced it.
const mounted = new Map<string, number>();

function read(key: string): Saved {
  if (typeof location === "undefined") return { path: [], pushed: 0 };
  const path = new URL(location.href).searchParams.getAll(key);
  const saved = (history.state as Record<string, Record<string, Saved>> | null)?.[STATE]?.[key];
  // The URL wins: an entry whose URL was edited by hand has no entries of ours behind it.
  const ours = saved && Array.isArray(saved.path) && same(saved.path, path) && (!saved.entry || saved.entry === entryKey());
  return { path, pushed: ours ? saved.pushed : 0 };
}
function write(key: string, next: Saved, push: boolean) {
  const url = new URL(location.href);
  url.searchParams.delete(key);
  next.path.forEach((id) => url.searchParams.append(key, id));
  const state = (history.state ?? {}) as Record<string, unknown>;
  const ours = { ...(state[STATE] as Record<string, Saved> | undefined) };
  // A new entry has no entries of another key's behind it in a row.
  if (push) for (const other of Object.keys(ours)) ours[other] = { ...ours[other]!, pushed: 0 };
  ours[key] = next;
  (push ? history.pushState : history.replaceState).call(history, { ...state, [STATE]: ours }, "", url);
  const entry = entryKey();
  if (entry) history.replaceState({ ...state, [STATE]: { ...ours, [key]: { ...next, entry } } }, "", url);
}

/**
 * Keeps a `RunNavigator` path in the browser history: the URL holds it as repeated `?<key>=<run id>` parameters (other
 * parameters, the hash, and other history state are kept), so reload and shared links reopen the same run. Opening a
 * run pushes one entry and browser back closes it. Back, Escape, and crumbs walk back over entries this hook pushed and
 * replace the entry in place past them, so they never leave the page or step over an entry someone else pushed. A path
 * that cannot open is corrected in place. Unmounting walks back over the entries it pushed. Use one key per navigator.
 *
 * ```tsx
 * <RunNavigator store={store} source={source} {...useHistoryRunPath("run")} />
 * ```
 */
export function useHistoryRunPath(key: string): { path: readonly string[]; onPathChange(path: readonly string[], change: RunPathChange): void } {
  const [saved, setSaved] = useState(() => read(key));
  useEffect(() => {
    mounted.set(key, (mounted.get(key) ?? 0) + 1);
    const sync = () => setSaved((now) => {
      const next = read(key);
      return same(now.path, next.path) && now.pushed === next.pushed ? now : next;
    });
    sync();
    addEventListener("popstate", sync);
    return () => {
      removeEventListener("popstate", sync);
      mounted.set(key, mounted.get(key)! - 1);
      setTimeout(() => {
        if (mounted.get(key)) return;
        // Walk back over our entries, then drop the path from the entry we land on (a deep link's own entry).
        const clear = () => read(key).path.length && write(key, { path: [], pushed: 0 }, false);
        const { pushed } = read(key);
        if (!pushed) return clear();
        addEventListener("popstate", clear, { once: true });
        history.go(-pushed);
      });
    };
  }, [key]);
  const onPathChange = useCallback((path: readonly string[], { replace }: RunPathChange) => {
    const now = read(key);
    if (same(path, now.path)) return;
    const up = now.path.length - path.length;
    const [shorter, longer] = up > 0 ? [path, now.path] : [now.path, path];
    const prefix = shorter.every((id, index) => id === longer[index]);
    if (!replace && up > 0 && prefix && up <= now.pushed) return history.go(-up);
    const down = !replace && prefix && up === -1;
    const next = { path: [...path], pushed: down ? now.pushed + 1 : 0 };
    write(key, next, down);
    setSaved(next);
  }, [key]);
  return { path: saved.path, onPathChange };
}
