import { useLayoutEffect, useRef, useState } from "react";
import type { ToolBodyProps } from "../parts.js";
import { Code, type Block } from "../highlight.js";
import { Arguments, asking, boundText, Empty, Foot, Output, outputBlocks, plainOutput } from "./common.js";
import { CodeViewer, isLargeCode } from "./text-viewer.js";

// The header cuts long commands to one line (a few on narrow screens); the body then repeats the command in full. A
// shorter one, approval or not, is whole in the header: the body would only repeat it.
const LONG_COMMAND = 72;
const showsCommand = (command: string) => command.length > LONG_COMMAND || command.includes("\n");

/** The highlight blocks ShellBody asks for when it first mounts. */
export function shellBlocks({ item, output, state }: ToolBodyProps): Block[] {
  if (item.view?.kind !== "shell") return [];
  const { command, stdout, stderr } = item.view;
  const done = state !== "streaming";
  const blocks: Block[] = showsCommand(command) ? [{ code: boundText(command).text, language: "shell", id: `${item.id}:command` }] : [];
  if (stdout !== undefined && stderr !== undefined) {
    if (stdout) blocks.push(...outputBlocks({ text: stdout, id: `${item.id}:stdout`, done }));
    if (stderr) blocks.push(...outputBlocks({ text: stderr, id: `${item.id}:stderr`, done }));
  } else if (output) blocks.push(...outputBlocks({ text: output, id: `${item.id}:output`, done }));
  return blocks;
}

export function ShellBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "shell") return null;
  const { command, cwd, exitCode, stdout, stderr } = item.view;
  const split = stdout !== undefined && stderr !== undefined;
  const all = split ? stdout + stderr : output;
  const done = state !== "streaming";
  return (
    <>
      {showsCommand(command) ? <Command text={boundText(command).text} id={`${item.id}:command`} /> : null}
      {split ? (
        <>
          {stdout ? <Output text={stdout} id={`${item.id}:stdout`} done={done} /> : null}
          {stderr ? <Output text={stderr} id={`${item.id}:stderr`} stream="stderr" done={done} /> : null}
        </>
      ) : output ? <Output text={output} id={`${item.id}:output`} done={done} /> : null}
      {all ? null : <Empty state={state} />}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[["command", command], ["output", all ? () => plainOutput(all) : undefined]]}>
        {exitCode !== undefined ? <span data-part="tool-exit" data-exit-code={exitCode}>exit {exitCode}</span> : null}
        {cwd ? <span data-part="tool-cwd">{boundText(cwd).text}</span> : null}
      </Foot>
    </>
  );
}

/** The command, clamped to a few lines by styles.css; a longer one gets a control that shows the rest. A large one is a viewer. */
function Command({ text, id }: { text: string; id: string }) {
  return isLargeCode(text) ? <CodeViewer text={text} language="shell" id={id} label="command" /> : <ClampedCommand text={text} id={id} />;
}

function ClampedCommand({ text, id }: { text: string; id: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded || typeof ResizeObserver === "undefined") return;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, text]);
  return (
    <>
      <pre ref={ref} data-part="shell-command" data-expanded={expanded ? "" : undefined}><Code text={text} language="shell" id={id} /></pre>
      {clamped && !expanded ? <button type="button" data-action="show-command" onClick={() => setExpanded(true)}>show full command</button> : null}
    </>
  );
}
