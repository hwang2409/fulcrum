import "./fonts.css";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import "./shell.css";
import themeSource from "@fulcrum/react/themes.css?raw";
import { useLayoutEffect, useState, type ReactNode } from "react";

// The theme list comes from the shipped themes.css, so the picker never drifts from it.
export const themeNames = [...themeSource.matchAll(/^\[data-fulcrum-theme="([^"]+)"\] \{$/gm)].map((match) => match[1]!);
const AUTO = "auto";
const pages = [
  ["playground", "/"],
  ["gallery", "/gallery.html"],
  ["virtual", "/virtual.html"],
  ["highlight", "/highlight.html"],
] as const;
// The active palette: bg, fg, accent, ok, warn, danger, then syntax keyword, string, function.
const paletteVars = ["bg", "fg", "accent", "ok", "warn", "danger", "tok-keyword", "tok-string", "tok-function"];

/** The playground page frame: brand, page links, and the theme picker, which keeps `?theme=` in the URL. */
export function Shell({ page, children }: { page: (typeof pages)[number][0]; children: ReactNode }) {
  const [theme, setTheme] = useState(() => {
    const value = new URLSearchParams(location.search).get("theme");
    return value && themeNames.includes(value) ? value : AUTO;
  });
  useLayoutEffect(() => {
    const url = new URL(location.href);
    if (theme === AUTO) {
      delete document.documentElement.dataset.fulcrumTheme;
      url.searchParams.delete("theme");
    } else {
      document.documentElement.dataset.fulcrumTheme = theme;
      url.searchParams.set("theme", theme);
    }
    history.replaceState(null, "", url);
  }, [theme]);
  const query = theme === AUTO ? "" : `?theme=${theme}`;
  return (
    <div className="shell">
      <header className="shell-bar">
        <a className="brand" href={`/${query}`}>fulcrum</a>
        <nav aria-label="pages">
          {pages.map(([name, path]) => (
            <a key={name} href={path + query} aria-current={name === page ? "page" : undefined}>{name}</a>
          ))}
        </nav>
        <div className="theme">
          <label htmlFor="theme">theme</label>
          <select id="theme" value={theme} onChange={(event) => setTheme(event.target.value)}>
            <option value={AUTO}>auto (github, follows the OS)</option>
            {themeNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <span className="palette" aria-hidden="true">
            {paletteVars.map((name) => <span key={name} style={{ background: `var(--fulcrum-${name})` }} />)}
          </span>
        </div>
      </header>
      {children}
    </div>
  );
}
