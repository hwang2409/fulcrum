import "@fulcrum/highlight/styles.css";
import "./highlight-demo.css";
import { createHighlighter, type Token } from "@fulcrum/highlight";
import { Tokens } from "@fulcrum/react/code";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./shell";

const highlight = createHighlighter();
window.addEventListener("pagehide", () => highlight.dispose(), { once: true });

const examples = [
  ["csharp", "record User(string Name);\nConsole.WriteLine($\"hello {user.Name}\");\n"],
  ["powershell", "$services = Get-Service\n$services | Where-Object Status -eq 'Running'\n"],
  ["dart", "void main() => print('hello dart');\n"],
  ["scala", "val users = List(\"Ada\", \"Grace\")\nusers.foreach(println)\n"],
  ["clojure", "(defn greet [name]\n  (str \"hello \" name))\n"],
  ["elixir", "def greet(name), do: \"hello #{name}\"\n"],
  ["haskell", "greet name = \"hello \" ++ name\n"],
  ["ocaml", "let greet name = \"hello \" ^ name\n"],
  ["zig", "const std = @import(\"std\");\npub fn main() void {}\n"],
  ["nix", "{ pkgs }: pkgs.mkShell { buildInputs = [ pkgs.bun ]; }\n"],
  ["terraform", "resource \"aws_s3_bucket\" \"logs\" {\n  bucket = \"fulcrum-logs\"\n}\n"],
  ["vue", "<template><button>{{ label }}</button></template>\n"],
  ["svelte", "<script>let count = 0;</script>\n<button on:click={() => count++}>{count}</button>\n"],
  ["astro", "---\nconst title = 'Fulcrum';\n---\n<h1>{title}</h1>\n"],
  ["julia", "function greet(name)\n  \"hello $name\"\nend\n"],
  ["solidity", "contract Counter { uint256 public count; }\n"],
  ["graphql", "query User($id: ID!) { user(id: $id) { name } }\n"],
  ["prisma", "model User { id Int @id name String }\n"],
  ["sql", "SELECT id FROM users WHERE active = true;\n"],
  ["toml", "[package]\nname = \"fulcrum\"\n"],
  ["dotenv", "FULCRUM_THEME=dracula\n"],
  ["dockerfile", "FROM oven/bun:1\nRUN bun install\n"],
  ["makefile", "build:\n\tbun run build\n"],
  ["cmake", "cmake_minimum_required(VERSION 3.25)\nproject(fulcrum)\n"],
  ["nginx", "server { listen 8080; location / { try_files $uri /index.html; } }\n"],
  ["csv", "name,status\nAda,ready\n"],
  ["latex", "\\section{Fulcrum}\nFast highlighting for agents.\n"],
  ["log", "2026-11-02T12:00:00Z INFO worker ready\n"],
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
  return <figure><figcaption>{language}</figcaption><pre><code><Tokens tokens={tokens} /></code></pre></figure>;
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
