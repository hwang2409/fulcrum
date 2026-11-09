import { createRunStore } from "@fulcrum/core";
import { Fallback, RunProvider } from "@fulcrum/react";
import { fromZetaHistory } from "@fulcrum/zeta";
import { renderToStaticMarkup } from "react-dom/server";

test("a text-less dropped steer reloads as a readable user row without raw wire text", () => {
  const store = createRunStore(() => {});
  for (const event of fromZetaHistory([{
    id: "drop-1",
    role: "system",
    event: "delivery_status",
    delivery_id: "d",
    method: "steer",
    status: "dropped",
    reason: "turn_end",
    content: [{ type: "text", text: "steer dropped: turn_end" }],
  }])) store.dispatch(event);

  const html = renderToStaticMarkup(<RunProvider store={store}><Fallback id="user:delivery:d" /></RunProvider>);
  expect(html).toContain("not delivered · the turn ended first · text not kept");
  expect(html).not.toContain("data-part=\"message-content\"");
  expect(html).not.toContain("steer dropped");
  expect(html).not.toContain("turn_end");
});
