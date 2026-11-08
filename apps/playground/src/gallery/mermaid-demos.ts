import type { RunEvent } from "@fulcrum/core";
import type { Demo } from "./demos";

// One fenced diagram of each common type, and one that mermaid cannot parse.
export const diagrams: Array<[id: string, title: string, intro: string, code: string]> = [
  ["flowchart", "flowchart", "How a streamed event reaches the screen:", [
    "flowchart LR",
    "  A[harness event] --> B{adapter}",
    "  B -->|RunEvent| C[reducer]",
    "  C --> D[(store)]",
    "  D -->|one frame| E[Timeline]",
    "  E --> F([virtual rows])",
    "  B -.->|unknown| G[Fallback]",
  ].join("\n")],
  ["pipeline", "flowchart, short", "One tool call, end to end:", [
    "flowchart LR",
    "  A[user prompt] --> B[agent loop]",
    "  B -->|tool call| C[bash]",
    "  C --> D[tool result]",
    "  D --> B",
  ].join("\n")],
  ["sequence", "sequence", "The approval round trip:", [
    "sequenceDiagram",
    "  autonumber",
    "  participant U as user",
    "  participant W as web client",
    "  participant Z as zeta serve",
    "  Z->>W: approval_request",
    "  W->>U: show the card",
    "  U->>W: approve",
    "  W->>Z: approval_respond",
    "  Note over W,Z: the socket may drop here",
    "  Z-->>W: approval_end",
  ].join("\n")],
  ["class", "class", "The store's public shape:", [
    "classDiagram",
    "  class RunStore {",
    "    +dispatch(event) void",
    "    +getOutline() OutlineItem[]",
    "    +getItem(id) RunItem",
    "    +subscribe(listener) () => void",
    "    +dispose() void",
    "  }",
    "  class Reducer {",
    "    +reduce(state, event) RunState",
    "  }",
    "  RunStore --> Reducer : batches per frame",
    "  RunStore \"1\" *-- \"many\" RunItem",
  ].join("\n")],
  ["state", "state", "A tool call's life:", [
    "stateDiagram-v2",
    "  [*] --> running",
    "  running --> waiting: approval_request",
    "  waiting --> running: approve",
    "  waiting --> denied: deny",
    "  running --> done: tool_result",
    "  running --> failed: is_error",
    "  done --> [*]",
    "  failed --> [*]",
    "  denied --> [*]",
  ].join("\n")],
  ["gantt", "gantt", "The release plan:", [
    "gantt",
    "  title fulcrum 0.1",
    "  dateFormat YYYY-MM-DD",
    "  section packages",
    "  core and react      :done, a1, 2026-10-01, 10d",
    "  virtual timeline    :done, a2, after a1, 8d",
    "  markdown            :active, a3, after a2, 12d",
    "  section release",
    "  docs                :a4, after a3, 5d",
    "  publish             :crit, a5, after a4, 2d",
  ].join("\n")],
  ["er", "entity relationship", "What a session stores:", [
    "erDiagram",
    "  SESSION ||--o{ RUN : has",
    "  RUN ||--|{ EVENT : records",
    "  RUN ||--o{ RUN : spawns",
    "  EVENT }o--o| APPROVAL : asks",
    "  SESSION {",
    "    string id PK",
    "    string cwd",
    "  }",
    "  EVENT {",
    "    int seq PK",
    "    string type",
    "    datetime at",
    "  }",
  ].join("\n")],
  ["invalid", "invalid", "This one has a typo:", [
    "flowchart TD",
    "  A[start] --> B(",
    "  B --> C[end]",
  ].join("\n")],
];

const fence = (intro: string, code: string) => `${intro}\n\n\`\`\`mermaid\n${code}\n\`\`\`\n`;
const commit = (id: string, value: string): RunEvent => ({ type: "message_commit", message_id: id, message: { role: "assistant", content: [{ type: "text", text: value } ] } });
// Line by line, as a model streams a fence; the streaming card stops halfway through the fence.
const lines = (id: string, value: string) => value.match(/[^\n]*\n|[^\n]+$/g)!.map((delta): RunEvent => ({ type: "message_delta", message_id: id, delta }));

export const mermaidDemos: Demo[] = [
  ...diagrams.flatMap(([id, title, intro, code]): Demo[] => {
    const deltas = lines(`mermaid-${id}-streaming`, fence(intro, code));
    return [
      {
        id: `mermaid-${id}-streaming`,
        part: "Mermaid",
        title: `${title}, streaming`,
        description: "While the fence is open it is the highlighted source, exactly as any code block.",
        events: deltas.slice(0, Math.ceil(deltas.length / 2) + 1),
      },
      {
        id: `mermaid-${id}-done`,
        part: "Mermaid",
        title: `${title}, done`,
        description: id === "invalid"
          ? "Mermaid cannot parse it: the source stays, with mermaid's short parse error under it."
          : "The fence closed: the diagram draws once, at idle time near the viewport, in the theme's colors. Switch to source, copy it, or open it full size.",
        events: [commit(`mermaid-${id}-done`, fence(intro, code))],
      },
    ];
  }),
  {
    id: "mermaid-tail",
    part: "Mermaid",
    title: "drawn, message still streaming",
    description: "The fence closed and the diagram drew, but the message has not said more yet: the diagram carries the running rail until the next text.",
    events: lines("mermaid-tail", fence(diagrams[0]![2], diagrams[0]![3])),
  },
  {
    id: "mermaid-live",
    part: "Mermaid",
    title: "live",
    description: "The flowchart streams in line by line; once its fence closes it switches to the diagram in one step.",
    events: [...lines("mermaid-live", fence(diagrams[0]![2], diagrams[0]![3]) + "\nThe adapter is the only harness-specific step."), commit("mermaid-live", fence(diagrams[0]![2], diagrams[0]![3]) + "\nThe adapter is the only harness-specific step.")],
    live: 220,
  },
];
