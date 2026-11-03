import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { RunPathChange } from "./run-navigation.js";

// The URL is the only state. This hook only ever writes the current entry or a new one; it never moves through the
// history list, not even on unmount. Entries it wrote are plain URL history, like a link's, so it cannot fight a router.
// A test reads this file and fails if a history traversal call appears.
const writes = new Set<() => void>();
const navigation = () => (globalThis as { navigation?: EventTarget }).navigation;
function subscribe(notify: () => void) {
  writes.add(notify);
  addEventListener("popstate", notify);
  addEventListener("hashchange", notify);
  // Where the Navigation API exists, a router's pushState is seen too; without it, a router's next render reads it.
  navigation()?.addEventListener("currententrychange", notify);
  return () => {
    writes.delete(notify);
    removeEventListener("popstate", notify);
    removeEventListener("hashchange", notify);
    navigation()?.removeEventListener("currententrychange", notify);
  };
}
const pathOf = (key: string) => new URLSearchParams(location.search).getAll(key);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Keeps a `RunNavigator` path in the URL as repeated `?<key>=<run id>` parameters, so reload, shared links, and
 * browser back and forward work. The URL is the only source of truth: the path is read from it on every render and
 * on `popstate`, `hashchange`, and Navigation API `currententrychange`. Each move the user makes (opening a run, back,
 * Escape, a crumb) pushes one entry, as a link would; a correction by the navigator (`replace`) replaces the current
 * entry. Other parameters, the hash, and `history.state` are kept. It never moves through the history list, and
 * unmounting does nothing, so it is safe under a host router. Use one key per navigator.
 *
 * ```tsx
 * <RunNavigator store={store} source={source} {...useHistoryRunPath("run")} />
 * ```
 */
export function useHistoryRunPath(key: string): { path: readonly string[]; onPathChange(path: readonly string[], change: RunPathChange): void } {
  // A string snapshot, so an unchanged path keeps the same array.
  const encoded = useSyncExternalStore(subscribe, () => JSON.stringify(pathOf(key)), () => "[]");
  const path = useMemo(() => JSON.parse(encoded) as readonly string[], [encoded]);
  const onPathChange = useCallback((next: readonly string[], { replace }: RunPathChange) => {
    if (same(next, pathOf(key))) return;
    const url = new URL(location.href);
    url.searchParams.delete(key);
    next.forEach((id) => url.searchParams.append(key, id));
    (replace ? history.replaceState : history.pushState).call(history, history.state, "", url);
    writes.forEach((notify) => notify());
  }, [key]);
  return { path, onPathChange };
}
