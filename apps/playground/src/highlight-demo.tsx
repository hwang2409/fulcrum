import "@fulcrum/highlight/styles.css";
import "./fonts.css";
import "./highlight-demo.css";
import { createHighlighter, type Token } from "@fulcrum/highlight";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const highlight = createHighlighter();
window.addEventListener("pagehide", () => highlight.dispose(), { once: true });

const examples = [
  ["typescript", "type Result = { ok: boolean };\nexport const result: Result = { ok: true };\n"],
  ["python", "def stream(items):\n    for item in items:\n        yield f\"event: {item}\"\n"],
  ["shell", "cat <<'JSON'\n{\"status\": \"ready\"}\nJSON\n"],
  ["diff", "--- a/run.ts\n+++ b/run.ts\n-const delay = 100;\n+const delay = 16;\n"],
] as const;

function Block({ language, source, index }: { language: string; source: string; index: number }) {
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
    const result = highlight(code, language, { id: `demo-${index}`, version, state: code === source ? "done" : "streaming" });
    if (result && "then" in result) void result.then(setTokens);
    else if (result) setTokens(result);
  }, [code, index, language, source]);
  return <figure><figcaption>{language}</figcaption><pre><code>{tokens.map((token, tokenIndex) => token.type ? <span className={`tok-${token.type}`} key={tokenIndex}>{token.text}</span> : token.text)}</code></pre></figure>;
}

function Demo() {
  return <main><header><p>streaming message</p><h1>plain first, highlighted by complete line</h1></header><article>{examples.map(([language, source], index) => <Block language={language} source={source} index={index} key={language} />)}</article></main>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
