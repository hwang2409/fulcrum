# @fulcrum/adapter-test

`@fulcrum/adapter-test` is a framework-free, test-only conformance runner for Fulcrum adapters. It is separate from `@fulcrum/core`, so production packages do not ship fixtures or assertions.

```ts
import { runAdapterConformance } from "@fulcrum/adapter-test";

const failures = runAdapterConformance({
  name: "my-harness",
  fixtures,
  create: (streamKey) => ({
    decode: (record) => createAdapter(streamKey).decode(
      typeof record === "object" && record !== null && "wire" in record ? record.wire : record,
    ),
  }),
  capabilities: { approval: false, reasoning: true, reset: false, usage: true },
});
if (failures.length) throw new Error(failures.join("\n"));
```

The canonical scenarios check text stream and commit; streamed or complete tool arguments; tool output, end, and error; aborts; unknown and malformed input; session isolation; adversarial wire and synthetic ids; replay-stable ids across independent streams; and stable ids after reconnect replay. Reasoning, approval, reset/retry, and usage apply only when declared in `capabilities`. `@fulcrum/zeta` and `@fulcrum/ai-sdk` use the same kit.

AI SDK fixtures come from `ai@6.0.0` and its token-free `MockLanguageModelV3`. Regenerate them with `bun run --cwd packages/ai-sdk fixtures`.
