/** The fulcrum theme tokens a diagram is drawn with (`--fulcrum-<name>`, from @fulcrum/react/themes.css). */
export const TOKENS = [
  "bg", "fg", "muted", "surface", "border", "accent", "danger", "ok", "warn",
  "tok-keyword", "tok-string", "tok-number", "tok-function", "tok-type", "tok-constant", "tok-operator", "tok-tag",
] as const;
export type Token = (typeof TOKENS)[number];

/**
 * What the diagram's colors and font depend on at `host`, as one string: the declared token values (a theme switch or
 * an OS color scheme change gives a different string) and the font. Cheap: it reads computed style and resolves nothing.
 */
export function themeKey(host: Element): string {
  const style = getComputedStyle(host);
  return `${TOKENS.map((name) => style.getPropertyValue(`--fulcrum-${name}`).trim()).join("|")}|${style.fontFamily}|${style.fontSize}`;
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** Mermaid's `base` theme, from the fulcrum tokens: quiet boxes, accent borders, and the syntax colors for series. */
export function themeVariables(c: Partial<Record<Token, string>>, fontFamily: string, fontSize: string) {
  const { bg, fg, muted, surface, border, accent, danger, ok, warn } = c;
  const series = [accent, c["tok-function"], c["tok-string"], c["tok-keyword"], c["tok-type"], c["tok-number"], c["tok-operator"], c["tok-tag"], c["tok-constant"], ok, warn, danger];
  const vars: Record<string, string | number | boolean | undefined> = {
    darkMode: bg ? luminance(bg) < 0.5 : undefined,
    // sharp and flat: no corner radius (mermaid draws state and round nodes with it), gradient, or shadow
    radius: 0, useGradient: false, dropShadow: "",
    fontFamily,
    fontSize,
    background: bg,
    textColor: fg,
    titleColor: fg,
    lineColor: muted,
    primaryColor: surface, primaryTextColor: fg, primaryBorderColor: accent,
    secondaryColor: surface, secondaryTextColor: fg, secondaryBorderColor: c["tok-function"],
    tertiaryColor: bg, tertiaryTextColor: fg, tertiaryBorderColor: border,
    mainBkg: surface, nodeBorder: accent, nodeTextColor: fg,
    clusterBkg: bg, clusterBorder: border, edgeLabelBackground: bg,
    noteBkgColor: surface, noteTextColor: fg, noteBorderColor: warn,
    // sequence
    actorBkg: surface, actorBorder: accent, actorTextColor: fg, actorLineColor: muted,
    signalColor: fg, signalTextColor: fg, labelBoxBkgColor: surface, labelBoxBorderColor: border, labelTextColor: fg,
    loopTextColor: fg, activationBkgColor: surface, activationBorderColor: accent, sequenceNumberColor: bg,
    // gantt
    sectionBkgColor: surface, altSectionBkgColor: bg, sectionBkgColor2: surface, gridColor: border, todayLineColor: warn,
    // bar text: bg on every filled bar (normal, active, done, crit), fg beside a bar
    taskBkgColor: accent, taskBorderColor: accent, taskTextColor: bg, taskTextLightColor: bg, taskTextDarkColor: bg, taskTextOutsideColor: fg, taskTextClickableColor: fg,
    activeTaskBkgColor: c["tok-function"], activeTaskBorderColor: c["tok-function"], doneTaskBkgColor: muted, doneTaskBorderColor: muted,
    critBkgColor: danger, critBorderColor: danger,
    // state, class, er
    labelColor: fg, altBackground: surface, classText: fg,
    attributeBackgroundColorOdd: bg, attributeBackgroundColorEven: surface, rowOdd: surface, rowEven: bg,
    errorBkgColor: danger, errorTextColor: fg,
  };
  series.forEach((color, index) => {
    vars[`pie${index + 1}`] = color;
    vars[`cScale${index}`] = color;
    vars[`cScaleLabel${index}`] = bg;
    if (index < 8) vars[`git${index}`] = color;
  });
  return Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== undefined));
}
