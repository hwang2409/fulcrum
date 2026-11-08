// Run in a child process by store.test.ts, because a store that spins never returns and would hang the test runner.
// A listener dispatches during a notification that started outside the scheduler, and the scheduler runs its job at
// once (a sync scheduler, or one drained from the listener). Prints what the listener and the store end on.
import type { RunEvent } from "../src/index.js";
import { createRunStore } from "../src/index.js";

const commit = (id: string): RunEvent => ({ type: "message_commit", message_id: id, message: { role: "assistant", content: [{ type: "text", text: id }] } });
const ids = (items: readonly { id: string }[]) => items.map(({ id }) => id);
const entry = process.argv[2];
const jobs: Array<() => void> = [];
const store = entry === "beginHistory" || entry === "prepend" || entry === "endHistory" ? createRunStore((job) => jobs.push(job)) : createRunStore((job) => job());
const drain = () => { while (jobs.length > 0) jobs.shift()!(); };
let armed = false;
let seen: string[] = [];
store.subscribe(() => {
  seen = ids(store.getState().outline);
  if (armed) armed = false, store.dispatch(commit("x")), drain();
});
// Leaves a reduced but undelivered change, so the entry's own notification has something to deliver.
const pendingChange = (id: string) => { store.dispatch(commit(id)); store.getState(); };

if (entry === "resync") {
  armed = true;
  store.resync([commit("a")]);
} else if (entry === "beginHistory") {
  pendingChange("a");
  armed = true;
  store.beginHistory();
} else if (entry === "prepend") {
  store.beginHistory();
  pendingChange("a");
  armed = true;
  store.prepend([commit("b")]);
} else if (entry === "endHistory") {
  store.beginHistory();
  store.prepend([commit("b")]);
  armed = true;
  store.endHistory();
} else if (entry === "prepend from a listener") {
  // A history page and a dispatch from one listener in a pass outside the scheduler: both land after the pass.
  store.beginHistory();
  const stop = store.subscribe(() => { stop(); store.prepend([commit("b")]); store.dispatch(commit("x")); });
  store.resync([commit("a"), commit("c")]);
} else if (entry === "endHistory from a listener") {
  store.beginHistory();
  const stop = store.subscribe(() => { stop(); store.prepend([commit("b")]); store.endHistory(); store.dispatch(commit("x")); });
  store.resync([commit("a"), commit("c")]);
} else throw new Error(`unknown entry ${entry}`);
drain();
console.log(JSON.stringify({ seen, outline: ids(store.getOutline()) }));
