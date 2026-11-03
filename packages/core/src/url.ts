/** URLs longer than this many characters are never shown. It leaves room for inline images (`data:image/...`). */
export const MAX_URL_CHARS = 8 * 1024 * 1024;
const dataImage = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/=]*$/i;
/**
 * The one URL rule for everything fulcrum renders. A link may be http, https, mailto, or relative to the page; an
 * image may also be an inline png, jpeg, gif, webp, avif, or bmp. Every other scheme (javascript:, data: otherwise,
 * file:, blob:, ...), protocol-relative `//host` URLs, and anything longer than `MAX_URL_CHARS` return undefined.
 */
export function safeUrl(url: unknown, use: "link" | "image" = "link"): string | undefined {
  // The length check comes first, so an oversized payload costs nothing before it is refused.
  if (typeof url !== "string" || url.length > MAX_URL_CHARS) return undefined;
  const value = url.trim();
  // Browsers drop control characters and spaces inside a scheme ("java\tscript:"), so the check does too.
  const normalized = value.replace(/[\u0000-\u0020]/g, "");
  if (/^(?:https?|mailto):/i.test(normalized)) return value;
  if (use === "image" && /^data:/i.test(normalized)) return dataImage.test(normalized) ? value : undefined;
  if (!/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^[\\/]{2}/.test(normalized)) return value;
  return undefined;
}
