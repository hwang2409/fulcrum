# Brief

fulcrum (repo hwang2409/fulcrum, public; local dir ~/me/fun/fulcrum) is a react component library for agent runs. zeta is the first adapter, not the only target.

## goal (Henry, binding, verbatim)
"lets try to get fulcrum to be the fastest, most performant, but also the best looking component library for agents, i think that is my ultimate goal"

## binding decisions
- "making it super fast + minimal": zero runtime deps in packages, ESM, bun workspaces, tsc.
- "i dont want this repo to only be zeta related components though": @fulcrum/core and @fulcrum/react never import @fulcrum/zeta.
- "yes, everything should merge into main, thanks": standing merge authorization after fresh review + green CI on the exact head.
- virtualization: Henry asked for it ("i think it would be nice to build something similar to devins virtualization engine for this component library. i think that would be a nice tool, that maybe i can apply to other things as well."). @fulcrum/virtual is generic, not agent-specific.
- virtualization by default: "yes". Timeline virtualizes automatically past a small threshold (about 200 items), with `virtual={false}` as the escape hatch.
- sub-agent detail: "i think it would be nice ui/ux if we could do something like click on some subagent button to view the subagent run or something like that". a sub-agent shows as a compact row/button in the parent run; clicking it opens the child run in its own view. no inline nested transcript by default.
- quality bar: "fulcrum should just be a painfully good, super optimized component library. people shouldnt have issues, there shouldnt be one component that was lazily thought out, and might need to be rewritten in the future, etc. it should just be state of the art". plan: ~/.zeta/scratch/fulcrum-sota-audit.md.
- font: JetBrains Mono on every page ("i really like jetbrains mono"), self-hosted.
- read-only observers: Henry wants them ("i think read only observers would be nice"); requested from the zeta project.

## packages
- @fulcrum/core: generic RunEvent, pure reducer (plain string streams, items + itemsById), store batched per frame.
- @fulcrum/react: useSyncExternalStore hooks, headless parts with data-* attributes, copy-in styles.css.
- @fulcrum/zeta: zeta serve wire types, adapter, json-rpc client, authenticated websocket connect (token in ?token=, loopback-only parsers).
- apps/playground: fixture replay, stress mode, live zeta mode, component gallery.
