import "@fulcrum/highlight/styles.css";
import "./highlight-demo.css";
import { createHighlighter, type Token } from "@fulcrum/highlight";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./shell";

const highlight = createHighlighter();
window.addEventListener("pagehide", () => highlight.dispose(), { once: true });

const examples = [
  ["typescript", "type Result = { ok: boolean };\nexport const result: Result = { ok: true };\n"],
  ["python", "def stream(items):\n    for item in items:\n        yield f\"event: {item}\"\n"],
  ["shell", "cat <<'JSON'\n{\"status\": \"ready\"}\nJSON\n"],
  ["diff", "--- a/run.ts\n+++ b/run.ts\n-const delay = 100;\n+const delay = 16;\n"],
] as const;

function Block({ id, language, source }: { id: string; language: string; source: string }) {
  const [code, setCode] = useState("");
  const [tokens, setTokens] = useState<Token[]>([]);
  useEffect(() => {
    let length = 0;
    const timer = setInterval(() => {
      length = Math.min(source.length, length + Math.max(1, Math.floor(source.length / 18)));
      setCode(source.slice(0, length));
      if (length === source.length) clearInterval(timer);
    }, 70);
    return () => clearInterval(timer);
  }, [source]);
  useEffect(() => {
    setTokens(code ? [{ text: code }] : []);
    const version = code.length;
    const result = highlight(code, language, { id, version, state: code === source ? "done" : "streaming" });
    if (result && "then" in result) void result.then(setTokens);
    else if (result) setTokens(result);
  }, [code, id, language, source]);
  return <figure><figcaption>{language}</figcaption><pre><code>{tokens.map((token, tokenIndex) => token.type ? <span className={`tok-${token.type}`} key={tokenIndex}>{token.text}</span> : token.text)}</code></pre></figure>;
}

function Demo() {
  const [run, setRun] = useState(0);
  return (
    <Shell page="highlight">
      <div className="toolbar">
        <button type="button" onClick={() => setRun(run + 1)}>replay</button>
      </div>
      <p className="caption">
        @fulcrum/highlight streams code the way a model writes it: text shows plain at once, and each complete line is highlighted in a worker.{" "}
        Token colors come from the theme&apos;s <code>--fulcrum-tok-*</code> variables; switch the theme to check each palette.
      </p>
      <main className="samples">
        {examples.map(([language, source]) => <Block key={`${language}-${run}`} id={`${language}-${run}`} language={language} source={source} />)}
      </main>
    </Shell>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
