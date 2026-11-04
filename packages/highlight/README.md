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

`highlight.subscribe(id, listener)` calls `listener({ version, status, reason? })` when a cached revision changes (including a colored pending replacement), completes, or becomes unavailable, and returns the unsubscribe function. `await highlight.awaitCompletion(id, version)` resolves with the same terminal notice for that exact revision, even if a newer revision is visible or the token entry is evicted. `pending` is provisional plain text; `complete` always contains the full pinned-grammar result for that exact source. `unavailable` is reserved for grammar failure, the 512 KiB/10,000-line size caps, or the bounded watchdog/worker failure paths. the worker warms a grammar in the background when a block first asks for it, in slices of at most 8 ms, and answers new requests between slices. a block asked for while its grammar is still cold is answered at once with its exact plain text and `pending`; once the grammar is warm, the worker continues until the full grammar result is ready. time slices only affect when colors arrive, never which tokens are final. `@fulcrum/react` and `@fulcrum/markdown` do this already. regexes are cached per highlighter: a grammar's own patterns until `dispose()`, and at most 256 patterns built while tokenizing (for example a markdown fence's end), least recently used first.

## the page's thread never tokenizes

all tokenizing runs in the worker. compiling one cold regex or scanner cannot be split (568 ms for cpp in chromium), so a ui freeze would be worse than missing colors, and there is no main-thread tokenizer to fall back to.

- a large result comes back in messages of at most 16,384 tokens, so the page's thread never reads one huge message in one task (a 330,000-token reply was a 133 ms task as one message).
- long work is not a failure. while it works, the worker sends a small progress message when it starts a block, after each line, and between grammar compile steps, at most every 100 ms. the page counts only silence: a 440 kb, 10,000-line block that takes seconds never trips it.
- if the worker says nothing for 500 ms while work is pending, one step that cannot be split (for example one pathological line) ran away. the block it last reported is blamed, not the worker: that block stays exact plain text for the life of this highlighter and is never sent again. the worker is replaced at once, and every other pending request goes to the new worker, so one bad block never turns colors off for the others.
- if the worker crashes (an `error` or `messageerror` event, or it cannot be built, as under a strict csp), or is silent with no block to blame, it is replaced after 250 ms, then 1 s, then 4 s, and gets every pending request again. up to 3 restarts in any 60 s are allowed.
- after a 4th crash in 60 s, or when there is no worker at all (ssr, tests without a `Worker`), every block is its exact plain text from then on, and is not cached as a final answer. nothing is announced to the user.
- `createHighlighter({ onHighlightUnavailable })` is called once, in a microtask, when highlighting stops for good, so an app can show its own notice if it wants to.

```ts
const highlight = createHighlighter({ onHighlightUnavailable: () => showNotice("syntax colors are off") });
```

`languageForPath("src/a.ts")` and `languageForContentType("application/json; charset=utf-8")` resolve a file path (extension or well-known name such as `Makefile`, `Dockerfile`, `.bashrc`) or an HTTP media type (including `+json` and `+xml` suffixes) to a language name, or undefined. Both are also exported from `@fulcrum/highlight/languages`, which imports no worker or grammar, so a bundler emits neither for code that only resolves names (`@fulcrum/react` uses it).

render typed fragments as text in `<span class="tok-<type>">` and untyped fragments as text nodes. import `@fulcrum/highlight/styles.css`; themes provide `--fulcrum-tok-<type>` variables. a strict csp only needs the static worker origin, for example `worker-src 'self'`. unknown languages return `null`.

## bundlers

the worker and each grammar load through static `new URL("...", import.meta.url)` references, so bundlers that understand that pattern emit them as separate lazy assets.

- vite (and rollup with its standard asset handling): works with no configuration. grammars load only when a block in that language is highlighted.
- esbuild: it keeps the urls but does not emit the files. copy `node_modules/@fulcrum/highlight/dist/worker.js`, `dist/chunks/`, and `dist/langs/` next to your bundle output (for example with an asset-copy plugin or a build step), keeping the same relative layout.
- other bundlers: if the worker cannot load, code shows as exact plain text (see above), so code is never lost.

## scope mapping

textmate scopes map to this stable set, in precedence order: comments to `comment`; strings to `string`; regexp strings/constants to `regexp`; numeric constants to `number`; language, character, and named constants to `constant`; keywords and storage declarations to `keyword`; keyword operators to `operator`; function entities/support/variables to `function`; type, class, namespace, and support types to `type`; variables to `variable`; punctuation to `punctuation`; tag entities to `tag`; attribute and property-name support scopes to `attribute`; diff insertions to `inserted`; diff deletions to `deleted`; and in markdown, headings to `keyword`, inline and fenced code to `string`, bold and italic to `constant`, links to `function`, and quotes to `comment`. unknown scopes remain unstyled. specific regexp, operator, constant, inserted, and deleted rules override broad rules.

aliases cover typescript/tsx, javascript/jsx, python, shell, json, diff, rust, go, sql, yaml, css, html, markdown, toml, dockerfile, c/c++, java, kotlin, swift, ruby, php, lua, makefile, ini, xml, graphql, and protobuf.
