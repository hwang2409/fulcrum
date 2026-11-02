import type { ToolBodyProps } from "../parts.js";
import { Code } from "../highlight.js";
import { Arguments, asking, boundText, Empty, Foot, Output, plainOutput } from "./common.js";

// The header cuts long commands to one line; the body then repeats the command in full.
const LONG_COMMAND = 72;

export function ShellBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "shell") return null;
  const { command, cwd, exitCode, stdout, stderr } = item.view;
  const split = stdout !== undefined && stderr !== undefined;
  const all = split ? stdout + stderr : output;
  const done = state !== "streaming";
  return (
    <>
      {asking(state) || command.length > LONG_COMMAND || command.includes("\n") ? (
        <pre data-part="shell-command"><Code text={boundText(command).text} language="shell" id={`${item.id}:command`} /></pre>
      ) : null}
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
