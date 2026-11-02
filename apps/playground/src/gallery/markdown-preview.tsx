// Hand-written markup in @fulcrum/markdown's output contract (data-part="md-*", <span class="tok-*">), so styles.css and
// every theme can be checked before the renderer lands. Replace with a real <Message markdown> demo when it does.
type Tok = [type: string, text: string] | string;
const code = (tokens: Tok[]) =>
  tokens.map((token, i) => (typeof token === "string" ? token : <span key={i} className={`tok-${token[0]}`}>{token[1]}</span>));

const fix: Tok[] = [
  ["comment", "// vite.config.ts: resolve paths without node:path"], "\n",
  ["keyword", "import"], " ", ["punctuation", "{"], " ", ["variable", "defineConfig"], " ", ["punctuation", "}"], " ", ["keyword", "from"], " ", ["string", '"vite"'], ["punctuation", ";"], "\n\n",
  ["keyword", "const"], " ", ["constant", "outDir"], " ", ["operator", "="], " ", ["keyword", "new"], " ", ["type", "URL"], ["punctuation", "("], ["string", '"./dist"'], ["punctuation", ","], " ", ["keyword", "import"], ["punctuation", "."], ["variable", "meta"], ["punctuation", "."], ["variable", "url"], ["punctuation", ")."], ["variable", "pathname"], ["punctuation", ";"], "\n",
  ["keyword", "export"], " ", ["keyword", "default"], " ", ["function", "defineConfig"], ["punctuation", "({"], " ", ["attribute", "build"], ["punctuation", ":"], " ", ["punctuation", "{"], " ", ["variable", "outDir"], ["punctuation", ","], " ", ["attribute", "chunkSizeWarningLimit"], ["punctuation", ":"], " ", ["number", "512"], " ", ["punctuation", "}"], " ", ["punctuation", "});"], "\n",
  ["comment", "// matches /^node:/ imports"], " ", ["regexp", "/^node:/"], "\n",
];
const diff: Tok[] = [
  ["deleted", '-import { resolve } from "node:path";'], "\n",
  ["inserted", '+const outDir = new URL("./dist", import.meta.url).pathname;'], "\n",
  " export default defineConfig({ build: { outDir } });\n",
];
const html: Tok[] = [
  ["punctuation", "<"], ["tag", "script"], " ", ["attribute", "type"], ["operator", "="], ["string", '"module"'], " ", ["attribute", "src"], ["operator", "="], ["string", '"/src/main.tsx"'], ["punctuation", "></"], ["tag", "script"], ["punctuation", ">"], "\n",
];

export function MarkdownPreview() {
  return (
    <div data-part="timeline">
      <div data-part="message" data-kind="message" data-role="assistant" data-state="done">
        <h2 data-part="md-heading">Why the build fails</h2>
        <p data-part="md-paragraph">
          <code data-part="md-code-inline">vite.config.ts</code> imports <code data-part="md-code-inline">node:path</code>,
          which does not exist in a browser bundle. <strong data-part="md-strong">Only the config</strong> needs the
          change; the app code is <em data-part="md-emphasis">fine</em>. See the{" "}
          <a data-part="md-link" href="#markdown-preview">vite docs on config</a>.
        </p>
        <pre data-part="md-code-block" data-language="ts">
          <code>{code(fix)}</code>
        </pre>
        <pre data-part="md-code-block" data-language="diff">
          <code>{code(diff)}</code>
        </pre>
        <h3 data-part="md-heading">Checked</h3>
        <ul data-part="md-list">
          <li data-part="md-list-item">
            <input type="checkbox" disabled checked /> reproduced the failure with <code data-part="md-code-inline">bun run build</code>
          </li>
          <li data-part="md-list-item">
            <input type="checkbox" disabled checked /> ran the core tests
            <ul data-part="md-list">
              <li data-part="md-list-item">42 pass, 0 fail</li>
            </ul>
          </li>
          <li data-part="md-list-item">
            <input type="checkbox" disabled /> run CI on the branch <del data-part="md-strike">tonight</del> now
          </li>
        </ul>
        <table data-part="md-table">
          <thead>
            <tr><th>step</th><th>before</th><th>after</th></tr>
          </thead>
          <tbody>
            <tr><td>build</td><td>failed</td><td>1.8 s</td></tr>
            <tr><td>tests</td><td>42 pass</td><td>42 pass</td></tr>
          </tbody>
        </table>
        <blockquote data-part="md-blockquote">
          <p data-part="md-paragraph">The entry script stays as it is:</p>
        </blockquote>
        <pre data-part="md-code-block" data-language="html">
          <code>{code(html)}</code>
        </pre>
        <hr data-part="md-rule" />
        <ol data-part="md-list">
          <li data-part="md-list-item">Merge the config fix.</li>
          <li data-part="md-list-item">Re-run the playground build.</li>
        </ol>
      </div>
    </div>
  );
}
