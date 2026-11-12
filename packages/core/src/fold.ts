/**
 * Case-folded text and, for each folded code unit, the original UTF-16 [start, end) of the character it came from.
 * Folding is per character (no context), so a length-changing fold (ß -> ss, İ -> i̇) maps back to whole characters,
 * and folding a piece of a text gives the same units as folding the whole text there.
 */
export function fold(value: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of value) {
    const start = offset;
    offset += character.length;
    const part = character.toUpperCase().toLowerCase();
    folded += part;
    for (let index = 0; index < part.length; index++) {
      starts.push(start);
      ends.push(offset);
    }
  }
  return { folded, starts, ends };
}
