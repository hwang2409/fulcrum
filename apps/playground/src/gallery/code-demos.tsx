import type { Highlight } from "@fulcrum/highlight";
import { Code, HighlightContext } from "@fulcrum/react";
import { useOverflowFocus } from "@fulcrum/react/code";

/** `Code` outside a run: one line of text highlighted by language, under a `HighlightContext`. */
export type CodeDemo = { id: string; part: "Code"; title: string; description: string; lines: Array<{ text: string; language: string }> };

export const codeDemos: CodeDemo[] = [{
  id: "code-inline",
  part: "Code",
  title: "outside a run",
  description: "Text a host shows outside the timeline (a command in a notice, a snippet in a tooltip), colored by language. Plain until the tokens arrive.",
  lines: [
    { text: "zeta serve --ws 8765 --ws-origin http://localhost:5180", language: "shell" },
    { text: 'const outDir = new URL("./dist", import.meta.url).pathname;', language: "ts" },
    { text: '{ "ok": true, "packages": 6 }', language: "json" },
  ],
}];

function CodeLine({ line, id }: { line: CodeDemo["lines"][number]; id: string }) {
  const overflow = useOverflowFocus(`${line.language} code`);
  return <pre {...overflow} className="code-line"><code><Code text={line.text} language={line.language} id={id} /></code></pre>;
}

export function CodeCard({ demo, highlight }: { demo: CodeDemo; highlight: Highlight }) {
  return (
    <article className="demo" id={demo.id}>
      <header className="demo-head">
        <div>
          <h3><a href={`#${demo.id}`}>{demo.title}</a></h3>
          <p>{demo.description}</p>
        </div>
      </header>
      <div className="demo-body">
        <HighlightContext value={highlight}>
          {demo.lines.map((line, index) => (
            <CodeLine key={line.text} line={line} id={`${demo.id}:${index}`} />
          ))}
        </HighlightContext>
      </div>
    </article>
  );
}
