# Visual directions

Three candidate replacements for `packages/react/styles.css`. Each file styles the same headless markup through
`data-*` attributes and `--fulcrum-*` variables. Pick one in the gallery header, or pin it with
`gallery.html?direction=<name>&theme=<name>`. `baseline` is the shipped `styles.css`, unchanged, kept for comparison.

Directions set shape, density, and motion. Themes (`../themes.css`, `data-fulcrum-theme`) set color. The two axes are
independent: any direction works with any theme.

All three use JetBrains Mono (OFL 1.1, self-hosted in the playground from `@fontsource-variable/jetbrains-mono`) with
`ui-monospace, SFMono-Regular, Menlo, monospace` as the fallback, so the library CSS works with or without the font.

## folio: quiet and editorial

Long agent runs are mostly reading. Folio treats the run like a document: one calm column with generous line height,
the user's question as a pulled quote, and tools as indented margin notes with a status word (running, done, failed).
Color appears only where the run needs the reader: a breathing dot while a tool runs, a red band on errors, and a
boxed amber notice on a pending approval. Best when the prose matters more than the tools.

## trace: dense and technical

For tool-heavy runs that read like a terminal session. Each tool is one row (rail, name, args, status badge) with its
output below on a recessed panel. A colored rail shows state at a glance down the whole run; args collapse to one line
and expand on hover. A pending approval gets a striped hazard band, its full request, and a solid ink button, because
the run is blocked on the user. Best for coding agents and anyone who scans many calls.

## pebble: soft product UI

A consumer chat product. The user speaks in a filled accent bubble, the assistant beside a small mark, tools sit in
rounded cards with a status pill and a light sweep while running. A pending approval lifts out with an amber ring and
a soft halo. New rows rise in once. Best for end-user facing assistants.

## Rules all three follow

- The same state vocabulary: running (accent), done (ok), failed (danger), and a pending approval in warn, the one
  color that means "the run waits on you".

- CSS only, each file under 6 kB unminified.
- Motion uses only `transform` and `opacity`, never runs per token in JS, and stops under `prefers-reduced-motion`.
- No `backdrop-filter`; only a pending approval gets a shadow.
- Timeline children keep `content-visibility: auto`.
- No horizontal page scroll at 390, 768, 1024, or 1440 px, and a pending approval's approve and deny have 4.5:1 text
  contrast and are at least 44 px tall at touch widths (36 px elsewhere), in light, dark, and pine
  (`bun run --cwd apps/playground layout`, in CI).
- Technical text (tool names, args, output) is at least 13 px.
