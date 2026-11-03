/** The palettes in `@fulcrum/react/themes.css`, in file order. Set one as `data-fulcrum-theme` on `<html>` or a subtree. */
export const themes = [
  "gruvbox-dark",
  "gruvbox-light",
  "dracula",
  "nord",
  "tokyo-night",
  "catppuccin-mocha",
  "catppuccin-latte",
  "solarized-dark",
  "solarized-light",
  "github-dark",
  "github-light",
  "one-dark",
] as const;
export type ThemeName = (typeof themes)[number];
