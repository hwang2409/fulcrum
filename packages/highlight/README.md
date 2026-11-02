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

render typed fragments as text in `<span class="tok-<type>">` and untyped fragments as text nodes. import `@fulcrum/highlight/styles.css`; themes provide `--fulcrum-tok-<type>` variables. a strict csp only needs the static worker origin, for example `worker-src 'self'`. unknown languages return `null`.

## scope mapping

textmate scopes map to this stable set, in precedence order: comments to `comment`; strings to `string`; regexp strings/constants to `regexp`; numeric constants to `number`; language, character, and named constants to `constant`; keywords and storage declarations to `keyword`; keyword operators to `operator`; function entities/support/variables to `function`; type, class, namespace, and support types to `type`; variables to `variable`; punctuation to `punctuation`; tag entities to `tag`; attribute and property-name support scopes to `attribute`; diff insertions to `inserted`; and diff deletions to `deleted`. unknown scopes remain unstyled. specific regexp, operator, constant, inserted, and deleted rules override broad rules.

aliases cover typescript/tsx, javascript/jsx, python, shell, json, diff, rust, go, sql, yaml, css, html, markdown, toml, dockerfile, c/c++, java, kotlin, swift, ruby, php, lua, makefile, ini, xml, graphql, and protobuf.
