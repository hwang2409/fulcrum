# accessibility verification

this page records the accessibility matrix for the playground component gallery and the zeta web app. it is a verification record, not a claim that untested screen-reader/browser pairs pass.

## baseline

- date: 2026-11-12
- revision: `6e142c0cf9c3968a2ffc73d20313e76d92163f47` (the sweep code of this record merged with main `d7c33dc`, which has #182 and #183; later commits change only this page)
- host: macos 26.6.2, arm64
- tools: bun 1.4.4, playwright 1.64.1, axe-core 4.11.1
- automated browser engines: chromium 156.0.8078.4 and webkit 27.2
- viewport and media variants: 1440×900 light, dark, and forced colors; 390×900 gallery light; 390×844 web light
- motion: reduced motion, so live gallery fixtures stay in a stable state

run the same sweep from the repository root:

```sh
PATH=/Users/henry/.bun/install/cache/@oven/bun-darwin-aarch64@1.4.4@@@1/bin:$PATH \
  bun run --cwd apps/playground a11y --output=a11y-results.json
```

the command builds the packages, starts private vite and fake-zeta processes on operating-system-selected free ports, scans the surfaces, captures chromium and webkit aria trees, writes the full axe node data to `a11y-results.json`, and stops its processes. the report includes the revision and exact tool versions.

### how the scan sees real pairs

long timelines skip layout and paint for off-screen rows: `content-visibility: auto` with a 2.5em placeholder (`packages/react/styles.css`). on an unscrolled page, the content of such a row overflows its placeholder and overlaps the next card. axe works from geometry, so it took another card as the background and reported false findings. the sweep now adds `[data-part="timeline"] > * { content-visibility: visible !important }` to the page before each scan, so axe measures every row at the size and position a user sees once the row renders. the product css does not change. scrolling each row into view was rejected: it needs one scan per row, and the other rows stay placeholders during each scan.

so that this cannot hide real defects, the sweep plants two real ones in the last, off-screen timeline row of the gallery in every mode: a text pair at about 1.3:1 (`forced-color-adjust: none`, so it stays low in forced colors) and an overflowing box with no tab stop. the script adds them to the page at scan time, so no bundle contains them. the sweep fails with `the sweep missed planted real defects` if axe does not report both as violations; the planted nodes are then removed from the reported counts. a scan that excluded the timeline failed this check in light 1440 for both plants.

## automated axe matrix

| surface and state | light 1440 | dark 1440 | forced colors 1440 | light 390 |
| --- | ---: | ---: | ---: | ---: |
| playground `/gallery.html`: every component card and state | 0 | 0 | 0 | 0 |
| apps/web: history, running message, tools, approval pending, and errors | 0 | 0 | 0 | 0 |
| apps/web: no sessions | not run | not run | not run | 0 |

the first record (`f1c7b66`) listed four defect classes. their state on this revision:

- `heading-order`: fixed by #174 (message headings start at h3).
- `region`: fixed by #180 (the mobile jump control sits inside a landmark).
- `scrollable-region-focusable`: fixed by #177 (scrollable code and output are keyboard reachable). 6 of the 12 gallery nodes at 390 in the first record were placeholder overlap, not real overflow.
- `color-contrast`: 0 real failures. the earlier 2 copy-button nodes (2.58:1 light, 2.60:1 dark, 1.84:1 forced colors) and the ansi cyan node at 390 (4.37:1) were placeholder overlap: axe's own related nodes were the approve button and a diff insert row of other cards. scrolled into view, the copy button is about 6.1:1 on its white card and the cyan is 4.93:1 on white. the same sweep with the override removed still reports them (2, 2, 2, and 3 nodes); the scan above reports 0. this is why pr #173 was closed. #182 then raised every ansi color in the default themes to 4.5:1 by measured math on the real backgrounds; this sweep still reports 0.
- `landmark-unique`: fixed by #183. the earlier 2 nodes in every mode were a repeated `code viewer` region name and a repeated `run path` navigation name; viewers are now `role="group"` and the breadcrumb navigation renders only at depth > 0.

axe leaves some nodes as "needs review" (incomplete) rather than pass or fail, and the json report counts them per rule with axe's reason. on this revision the gallery has 304 to 425 incomplete `color-contrast` nodes per mode, mostly `pseudoContent` (a background from a pseudo-element) and `elmPartiallyObscured` (axe found another element over part of the text). this sweep does not judge those nodes, so "0 real failures" covers only what axe could decide.

the two apps/web mobile `scrollable-region-focusable` nodes from the first record are fixed by #177. the full selectors, html, impact, and axe failure summaries are in the generated json report.

on this revision the full command (packages already built once, so the build step reused its outputs) took 31 seconds at a load average of about 6. the web scans wait for conditions (the run no longer streams and the live region is stable for longer than the announcer's 1 s batch window), not fixed sleeps, and each axe run has a 60 s deadline. the sweep is not in ci yet; now that it reports 0 violations, the next step is to add the browser-only script (`bun apps/playground/scripts/a11y.ts`) to an existing browser job, with the package build kept as that job's existing setup.

## accessibility-tree and interaction checks

chromium and webkit aria trees were captured for the gallery, the populated web run, and the empty web state. chromium's pre-append live region contains `3 new items` because the fake zeta's scripted live turn emits three completed rows during setup; the measured append uses four distinct rows and waits for the distinct `4 new items` result.

| check | chromium | webkit | result |
| --- | --- | --- | --- |
| timeline log role and name | captured | captured | `role="log"`, named `agent activity` in the gallery and `session activity` in apps/web; `aria-live="off"` avoids replaying the transcript |
| paced append announcement | captured | captured | the separate polite live region coalesced four appended sub-agent updates to `4 new items` in both engines rather than announcing every update |
| history reconstruction/prepend | live turn already active | captured | webkit reconstructed the populated history with an empty live region; history rows enter the named log without making the log live |
| approval group and controls | captured | captured | the group is labelled by its tool heading; `approve`, `always allow` when available, and `deny` expose button names and disabled state |
| approval keyboard path | exercised | tree captured | `jump to approval: write docs/notes.md +8` moves focus to `approve`; the next tab stop is `deny` |
| page skip link | captured | captured | the first gallery link is `skip to content` and targets `#main` |
| sub-agent open control | captured | captured | the button name includes agent name, task, status, elapsed time, and tool count |
| notification | captured | captured | the row is a named `notification` group and exposes its summary |
| row render-error fallback | focused react test | focused react test | the fallback text is `this item could not be shown · <id>` with `role="status"`; this state cannot be induced through the production apps/web renderer, so no browser tree was claimed |
| mermaid fallback | gallery + focused mermaid test | gallery + focused mermaid test | invalid or unavailable rendering exposes the source text instead of an empty diagram |

## screen-reader matrix

| screen reader | browser | status | evidence |
| --- | --- | --- | --- |
| nvda | firefox | not run | nvda and windows are not available on this macos host |
| jaws | chrome | not run | jaws and windows are not available on this macos host |
| voiceover | safari | not run | would alter the active desktop |
| webkit accessibility tree | playwright webkit | run | WebKit AX tree captured; VoiceOver not run (would alter the active desktop) |
| chromium accessibility tree | playwright chromium | run | aria tree and approval focus order captured |

nvda/firefox, jaws/chrome, and voiceover/safari remain required manual smoke cells before claiming the full matrix. a webkit tree verifies browser semantics, but it is not a substitute for voiceover speech, rotor order, or interaction behavior.
