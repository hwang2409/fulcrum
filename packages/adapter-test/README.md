# @fulcrum/adapter-test

`@fulcrum/adapter-test` is a framework-free, test-only conformance runner for Fulcrum adapters. It is separate from `@fulcrum/core`, so production packages do not ship fixtures or assertions.

```ts
import { runAdapterConformance } from "@fulcrum/adapter-test";

const failures = runAdapterConformance({
  name: "my-harness",
  fixtures,
  create: (streamKey) => ({ decode: (record) => createAdapter(streamKey).decode(record.wire) }),
  capabilities: { approval: false, reasoning: true, reset: false, usage: true },
});
if (failures.length) throw new Error(failures.join("\n"));
```

The kit checks text, tools, aborts, malformed and unknown input, isolation, id collisions, replay, and declared optional capabilities. `@fulcrum/zeta` and `@fulcrum/ai-sdk` use it too.
