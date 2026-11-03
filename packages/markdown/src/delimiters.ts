// CommonMark delimiter-run rules, shared by the closed-line hider and the pending-line owner scan.
const whitespace = (character: string | undefined) => character === undefined || /\s/u.test(character);
const punctuation = (character: string | undefined) => character !== undefined && /[\p{P}\p{S}]/u.test(character);

export type DelimiterRun = { readonly canOpen: boolean; readonly canClose: boolean };

/** Classifies the `*`, `_`, or `~` run of `length` characters that starts at `index`. */
export function delimiterRun(source: string, index: number, length: number): DelimiterRun {
  const marker = source[index]!;
  const previous = index ? [...source.slice(Math.max(0, index - 2), index)].at(-1) : undefined;
  const next = source[index + length] === undefined ? undefined : String.fromCodePoint(source.codePointAt(index + length)!);
  const leftFlanking = !whitespace(next) && (!punctuation(next) || whitespace(previous) || punctuation(previous));
  const rightFlanking = !whitespace(previous) && (!punctuation(previous) || whitespace(next) || punctuation(next));
  if (marker !== "_") return { canOpen: leftFlanking, canClose: rightFlanking };
  return {
    canOpen: leftFlanking && (!rightFlanking || punctuation(previous)),
    canClose: rightFlanking && (!leftFlanking || punctuation(next)),
  };
}
