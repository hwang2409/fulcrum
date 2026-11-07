# @fulcrum/react

`@fulcrum/react` provides React 19 hooks and headless parts over `@fulcrum/core`. It does not import `@fulcrum/zeta`.

## basic usage

```tsx
import { createRunStore } from "@fulcrum/core";
import { RunProvider, Timeline } from "@fulcrum/react";

const store = createRunStore();

<RunProvider store={store}><Timeline /></RunProvider>;
```

## hooks and parts

- hooks: `useRun`, `useTimeline`, `useItem`, and `useItemSelector`; they use `useSyncExternalStore`.
- parts: `Timeline`, `Message`, `ToolCall`, `Approval`, `SubAgent`, `RunNavigator`, and `Fallback`.
- status: `RunStatus`, `useRunStatus`, and `RunEndMarker` expose run state and reported outcomes.
- `Timeline` virtualizes long outlines by default. Set `virtual={false}` when browser find-in-page must search every row.

Keep renderer objects stable. Renderer keys are item kinds or `tool:<name>`. `Timeline` owns its scroll area by default. Pass a `scrollRef` for a host-owned scroll area. The virtual lane and jump-to-latest control reserve their own space and do not cover transcript text.

## styling hooks

Copy `styles.css` and `themes.css`. Parts expose `data-part`, `data-kind`, and state attributes. Common parts include `data-part="timeline"`, `data-part="message"`, `data-part="tool-call"`, `data-part="approval"`, `data-part="run-status"`, and `data-status="idle|running|approval|unknown"`. Use the part attributes instead of internal class names.
