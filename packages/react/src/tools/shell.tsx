import type { ToolBodyProps } from "../parts.js";
import { Code, type Block } from "../highlight.js";
import { Arguments, asking, boundText, Empty, Foot, Output, outputBlocks, plainOutput } from "./common.js";

// The header cuts long commands to one line; the body then repeats the command in full.
const LONG_COMMAND = 72;
const showsCommand = (command: string, state: ToolBodyProps["state"]) => asking(state) || command.length > LONG_COMMAND || command.includes("\n");

/** The highlight blocks ShellBody asks for when it first mounts. */
export function shellBlocks({ item, output, state }: ToolBodyProps): Block[] {
  if (item.view?.kind !== "shell") return [];
  const { command, stdout, stderr } = item.view;
  const done = state !== "streaming";
  const blocks: Block[] = showsCommand(command, state) ? [{ code: boundText(command).text, language: "shell", id: `${item.id}:command` }] : [];
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
      {showsCommand(command, state) ? (
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
