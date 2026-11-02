import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, boundText, Empty, Foot, Output } from "./common.js";

// The header cuts long commands to one line; the body then repeats the command in full.
const LONG_COMMAND = 72;

export function ShellBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "shell") return null;
  const { command, cwd, exitCode, stdout, stderr } = item.view;
  const split = stdout !== undefined && stderr !== undefined;
  const all = split ? stdout + stderr : output;
  return (
    <>
      {asking(state) || command.length > LONG_COMMAND || command.includes("\n") ? <pre data-part="shell-command">{boundText(command).text}</pre> : null}
      {split ? (
        <>
          {stdout ? <Output text={stdout} /> : null}
          {stderr ? <Output text={stderr} stream="stderr" /> : null}
        </>
      ) : output ? <Output text={output} /> : null}
      {all ? null : <Empty state={state} />}
      {asking(state) ? <Arguments call={item.tool_call} version={item.version} /> : null}
      <Foot copy={[["command", command], ["output", all]]}>
        {exitCode !== undefined ? <span data-part="tool-exit" data-exit-code={exitCode}>exit {exitCode}</span> : null}
        {cwd ? <span data-part="tool-cwd">{boundText(cwd).text}</span> : null}
      </Foot>
    </>
  );
}
