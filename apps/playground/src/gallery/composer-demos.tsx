import { Composer, type ComposerState } from "@fulcrum/react";
import { useEffect, useRef, useState } from "react";

/**
 * Composer states for the gallery. `submit` and `stop` say how the fake harness answers: "pending" never settles and
 * "reject" fails, so the card freezes in that state; the card presses the action once on mount to get there.
 * `live` is a working fake harness: send starts a turn that runs for a few seconds, steer and stop act on it.
 */
export type ComposerDemo = {
  id: string;
  part: "Composer";
  title: string;
  description: string;
  state: ComposerState;
  reason?: string;
  draft?: string;
  submit?: "pending" | "reject";
  stop?: "pending" | "reject";
  live?: true;
};

const demo = (id: string, title: string, description: string, rest: Omit<ComposerDemo, "id" | "part" | "title" | "description">): ComposerDemo => ({ id: `composer-${id}`, part: "Composer", title, description, ...rest });
const long = Array.from({ length: 24 }, (_, index) => `${index + 1}. check the ${["reducer", "store", "virtual list", "markdown parser"][index % 4]} under 4x cpu throttling`).join("\n");

export const composerDemos: ComposerDemo[] = [
  demo("live", "live", "A working fake harness: send starts a turn for 6 s, steer adds to it, stop ends it. Every call takes 600 ms.", { state: "idle", live: true }),
  demo("idle", "idle", "No turn runs. Enter sends, Shift+Enter adds a line; a blank draft cannot send.", { state: "idle" }),
  demo("draft", "draft", "A short draft: the field grows a line at a time.", { state: "idle", draft: "the reconnect test fails one run in ten.\nfind out why and fix it." }),
  demo("grow", "long draft", "The field stops growing at ten lines and scrolls; the bar stays in place.", { state: "idle", draft: long }),
  demo("sending", "sending", "Submit is in flight: the action is disabled, and the field keeps the draft.", { state: "idle", draft: "run the full suite once", submit: "pending" }),
  demo("send-error", "send failed", "The harness rejected it: the draft stays, the error is announced, and send retries. Same height as sending.", { state: "idle", draft: "run the full suite once", submit: "reject" }),
  demo("steerable", "steer", "A turn runs and the harness takes input into it: the action is steer, and stop is shown.", { state: "steerable", draft: "also check the windows path" }),
  demo("steering", "steering", "A steer is in flight.", { state: "steerable", draft: "also check the windows path", submit: "pending" }),
  demo("running", "running, no steering", "The harness cannot take input mid-turn: send is disabled and the draft waits. Nothing is queued.", { state: "running", draft: "next: update the docs" }),
  demo("stopping", "stopping", "Stop is in flight.", { state: "steerable", stop: "pending" }),
  demo("stop-error", "stop failed", "Stop failed: the error says why, and stop retries.", { state: "steerable", stop: "reject" }),
  demo("read-only", "read-only", "This view cannot act: no actions, and the reason. A draft stays on screen, read-only.", { state: "read-only", reason: "reconnecting · sending is paused until the server confirms this session", draft: "draft kept across the disconnect" }),
];

const never = () => new Promise<never>(() => {});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function useLiveHarness(toast: (message: string) => void) {
  const [state, setState] = useState<"idle" | "steerable">("idle");
  const turn = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(turn.current), []);
  const end = () => { clearTimeout(turn.current); setState("idle"); };
  return {
    state,
    async onSubmit(text: string, { steer }: { steer: boolean }) {
      await wait(600);
      if (text.trim() === "fail") throw new Error("the harness refused this message");
      toast(`${steer ? "steered" : "sent"}: ${text.slice(0, 40)}`);
      if (!steer) {
        setState("steerable");
        turn.current = setTimeout(end, 6000);
      }
    },
    async onStop() {
      await wait(600);
      end();
      toast("stopped");
    },
  };
}

export function ComposerCard({ demo, toast }: { demo: ComposerDemo; toast: (message: string) => void }) {
  const body = useRef<HTMLDivElement>(null);
  const live = useLiveHarness(toast);
  // Frozen states: act once, after mount, so the card shows the state the harness answer leads to. Submit goes through
  // Enter in the field and stop through a click, the two paths that never move focus, so the page keeps its scroll.
  useEffect(() => {
    if (demo.submit) body.current?.querySelector("textarea")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    else if (demo.stop) body.current?.querySelector<HTMLButtonElement>('[data-part="composer-stop"]')?.click();
  }, [demo]);
  const answer = (mode?: "pending" | "reject") => () => (mode === "reject" ? Promise.reject(new Error("socket closed before the server answered")) : mode === "pending" ? never() : Promise.resolve());
  const props = demo.live
    ? { state: live.state, onSubmit: live.onSubmit, onStop: live.onStop }
    : { state: demo.state, onSubmit: answer(demo.submit), onStop: answer(demo.stop) };
  return (
    <article className="demo" id={demo.id}>
      <header className="demo-head">
        <div>
          <h3>
            <a href={`#${demo.id}`}>{demo.title}</a>
            {demo.live ? <span className="live">live</span> : null}
          </h3>
          <p>{demo.description}</p>
        </div>
      </header>
      <div className="demo-body" ref={body}>
        {props.state === "read-only" ? (
          <Composer state="read-only" reason={demo.reason!} label={`message (${demo.title})`} defaultValue={demo.draft} onSubmit={props.onSubmit} />
        ) : (
          <Composer {...props} state={props.state} label={`message (${demo.title})`} placeholder="message the agent" defaultValue={demo.draft} />
        )}
      </div>
    </article>
  );
}
