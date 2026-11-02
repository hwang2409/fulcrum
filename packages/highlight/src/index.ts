export type { Highlight, HighlightContext, Token, TokenType } from "./types.js";
export { TOKEN_TYPES } from "./types.js";
export type { HighlighterOptions } from "./controller.js";
export { createController as createHighlighter } from "./controller.js";
export { languageForContentType, languageForPath } from "./names.js";
