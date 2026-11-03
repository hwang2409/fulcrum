// A real store and Timeline for scripts/fold-check.ts: a long session with pending approvals above the reader, which
// fold into their tool rows one by one while the last message streams.
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { RunProvider, Timeline } from "@fulcrum/react";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";

const params = new URLSearchParams(location.search);
const rows = Number(params.get("rows") ?? 100_000);
const folds = Number(params.get("folds") ?? 30);
const store = createRunStore();
const call = (index: number) => ({ id: `call-${index}`, name: "bash", arguments: { command: `echo ${index}` } });
// Approvals sit in the middle third, so each fold edits a row above a reader parked lower down.
const approvalAt = (index: number) => Math.floor(rows / 3) + index * 50;
const seed: RunEvent[] = [];
for (let row = 0, next = 0; row < rows; row++) {
  if (next < folds && row === approvalAt(next)) {
    seed.push({ type: "approval_request", request_id: `call-${next}`, tool_call: call(next), delegated: false });
    next++;
  } else seed.push({ type: "message_commit", message_id: `m${row}`, message: { role: row % 2 ? "assistant" : "user", content: [{ type: "text", text: `message ${row}\nsecond line` }] } });
}
const started = performance.now();
for (const event of seed) store.dispatch(event);
store.getOutline();
const seedMs = performance.now() - started;

const fold = (index: number) => {
  store.dispatch({ type: "approval_end", request_id: `call-${index}`, decision: "approve" });
  store.dispatch({ type: "tool_start", tool_call: call(index) });
  store.dispatch({ type: "tool_output", tool_call: call(index), output: `${index}\n` });
  store.dispatch({ type: "tool_end", tool_call: call(index), tool_result: { tool_call_id: `call-${index}`, content: `${index}\n`, is_error: false } });
};
const stream = () => store.dispatch({ type: "message_delta", message_id: "live", delta: "word " });
Object.assign(window, { __fold: { fold, stream, seedMs, rows, folds, approvalId: (index: number) => `approval:call-${index}` } });

function App() {
  const scroll = useRef<HTMLDivElement>(null);
  return (
    <RunProvider store={store}>
      <div ref={scroll} data-testid="scroll" style={{ height: "100vh", overflow: "auto" }}>
        <Timeline virtual scrollRef={scroll} />
      </div>
    </RunProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
