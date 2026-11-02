# Brief

fulcrum (repo hwang2409/fulcrum, private; local dir ~/me/fun/react) is a react component library for agent runs. zeta is the first adapter, not the only target.

## goal (Henry, binding, verbatim)
"lets try to get fulcrum to be the fastest, most performant, but also the best looking component library for agents, i think that is my ultimate goal"

## binding decisions
- "making it super fast + minimal": zero runtime deps in packages, ESM, bun workspaces, tsc.
- "i dont want this repo to only be zeta related components though": @fulcrum/core and @fulcrum/react never import @fulcrum/zeta.
- "yes, everything should merge into main, thanks": standing merge authorization after fresh review + green CI on the exact head.
- no virtual list without asking Henry; measure first, on production builds.
- read-only observers: Henry wants them ("i think read only observers would be nice"); requested from the zeta project.

## packages
- @fulcrum/core: generic RunEvent, pure reducer (plain string streams, items + itemsById), store batched per frame.
- @fulcrum/react: useSyncExternalStore hooks, headless parts with data-* attributes, copy-in styles.css.
- @fulcrum/zeta: zeta serve wire types, adapter, json-rpc client, authenticated websocket connect (token in ?token=, loopback-only parsers).
- apps/playground: fixture replay, stress mode, live zeta mode, component gallery.
