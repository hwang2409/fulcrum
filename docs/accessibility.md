# accessibility verification

this page records the accessibility matrix for the playground component gallery and the zeta web app. it is a verification record, not a claim that untested screen-reader/browser pairs pass.

## baseline

- date: 2026-11-11
- revision: `f1c7b66e0276d63a1bd201f9c6dd136dd2fb82a2`
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

## automated axe matrix

| surface and state | light 1440 | dark 1440 | forced colors 1440 | light 390 |
| --- | ---: | ---: | ---: | ---: |
| playground `/gallery.html`: every component card and state | 4 rules, 9 nodes | 4 rules, 9 nodes | 4 rules, 9 nodes | 5 rules, 20 nodes |
| apps/web: history, running message, tools, approval pending, and errors | 0 | 0 | 0 | 1 rule, 2 nodes |
| apps/web: no sessions | not run | not run | not run | 0 |

axe reported four implementation defect classes. the implementation work is split by class so one fix does not hide another:

- `scrollable-region-focusable`: 3 gallery nodes at 1440, 12 gallery nodes at 390, and 2 apps/web nodes at 390. scrollable tool output and code/source blocks are not keyboard focusable.
- `color-contrast`: 2 text-viewer copy buttons at 1440 and 390. their measured ratios are 2.58:1 in light, 2.60:1 in dark, and 1.84:1 in forced colors. one ansi cyan sample is 4.37:1 at 390.
- gallery document structure: `heading-order` affects 2 card headings that follow deeper headings rendered by the previous markdown demo; `region` affects the mobile jump control because it sits outside every landmark.
- `landmark-unique`: one repeated `code viewer` region name and one repeated `run path` navigation name.

apps/web had no axe violations in the 1440 history/running/tools/approval state in light, dark, or forced colors. its two mobile findings are the same scrollable-code class found in the gallery. the full selectors, html, impact, and axe failure summaries are in the generated json report.

two browser-only calibration runs took 44.73 and 43.51 seconds. their rule ids, impacts, and node selectors were identical. the sweep is not in ci yet because the baseline intentionally contains known failures and the complete command also builds packages. after the defect prs merge, add the browser-only script to an existing browser job; keep the package build in that job as its existing setup rather than adding a second build.

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
