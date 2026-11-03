# @fulcrum/highlight

lazy, worker-first syntax highlighting for streamed agent output. the published package bundles its javascript regex engine and textmate grammars, has no runtime dependencies, and uses no wasm, html injection, blob url, `eval`, or `new Function`.

```ts
import { createHighlighter } from "@fulcrum/highlight";

const highlight = createHighlighter();
const tokens = await highlight(code, "typescript", {
  id: "message-1:fence-0",
  version: 3,
  state: "streaming",
});
highlight.dispose();
```

`highlight.subscribe(id, listener)` calls `listener` when the cached tokens of block `id` were replaced, and returns the unsubscribe function. the worker warms a grammar in the background when a block first asks for it, in slices of at most 8 ms, and answers new requests between slices. a line that ran out of time while its grammar was still cold is sent plain first; once the grammar is warm, the worker tokenizes that block once more and the cache gets the colored tokens (same text, new spans), so ask again on that call. `@fulcrum/react` and `@fulcrum/markdown` do this already. the main-thread fallback never warms a grammar: one regex compile cannot be split, so it must not run on the page's thread, and a line over its time budget there stays plain. regexes are cached per highlighter: a grammar's own patterns until `dispose()`, and at most 256 patterns built while tokenizing (for example a markdown fence's end), least recently used first.

`languageForPath("src/a.ts")` and `languageForContentType("application/json; charset=utf-8")` resolve a file path (extension or well-known name such as `Makefile`, `Dockerfile`, `.bashrc`) or an HTTP media type (including `+json` and `+xml` suffixes) to a language name, or undefined. Both are also exported from `@fulcrum/highlight/languages`, which imports no worker or grammar, so a bundler emits neither for code that only resolves names (`@fulcrum/react` uses it).

render typed fragments as text in `<span class="tok-<type>">` and untyped fragments as text nodes. import `@fulcrum/highlight/styles.css`; themes provide `--fulcrum-tok-<type>` variables. a strict csp only needs the static worker origin, for example `worker-src 'self'`. unknown languages return `null`.

## bundlers

the worker and each grammar load through static `new URL("...", import.meta.url)` references, so bundlers that understand that pattern emit them as separate lazy assets.

- vite (and rollup with its standard asset handling): works with no configuration. grammars load only when a block in that language is highlighted.
- esbuild: it keeps the urls but does not emit the files. copy `node_modules/@fulcrum/highlight/dist/worker.js`, `dist/chunks/`, and `dist/langs/` next to your bundle output (for example with an asset-copy plugin or a build step), keeping the same relative layout.
- other bundlers: if the worker cannot load, highlighting falls back to sliced main-thread work and shows plain text first, so code is never lost.

## scope mapping

textmate scopes map to this stable set, in precedence order: comments to `comment`; strings to `string`; regexp strings/constants to `regexp`; numeric constants to `number`; language, character, and named constants to `constant`; keywords and storage declarations to `keyword`; keyword operators to `operator`; function entities/support/variables to `function`; type, class, namespace, and support types to `type`; variables to `variable`; punctuation to `punctuation`; tag entities to `tag`; attribute and property-name support scopes to `attribute`; diff insertions to `inserted`; diff deletions to `deleted`; and in markdown, headings to `keyword`, inline and fenced code to `string`, bold and italic to `constant`, links to `function`, and quotes to `comment`. unknown scopes remain unstyled. specific regexp, operator, constant, inserted, and deleted rules override broad rules.

aliases cover typescript/tsx, javascript/jsx, python, shell, json, diff, rust, go, sql, yaml, css, html, markdown, toml, dockerfile, c/c++, java, kotlin, swift, ruby, php, lua, makefile, ini, xml, graphql, and protobuf.
