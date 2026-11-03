/** Inline images (`data:image/...`) longer than this many characters are not shown. */
export const MAX_DATA_IMAGE_CHARS = 8 * 1024 * 1024;
const dataImage = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/=]*$/i;
/**
 * The one URL rule for everything fulcrum renders. A link may be http, https, mailto, or relative to the page; an
 * image may also be an inline png, jpeg, gif, webp, avif, or bmp up to `MAX_DATA_IMAGE_CHARS`. Every other scheme
 * (javascript:, data: otherwise, file:, blob:, ...) and protocol-relative `//host` URLs return undefined.
 */
export function safeUrl(url: unknown, use: "link" | "image" = "link"): string | undefined {
  if (typeof url !== "string") return undefined;
  const value = url.trim();
  // Browsers drop control characters and spaces inside a scheme ("java\tscript:"), so the check does too.
  const normalized = value.replace(/[\u0000-\u0020]/g, "");
  if (/^(?:https?|mailto):/i.test(normalized)) return value;
  if (use === "image" && /^data:/i.test(normalized)) return value.length <= MAX_DATA_IMAGE_CHARS && dataImage.test(normalized) ? value : undefined;
  if (!/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^[\\/]{2}/.test(normalized)) return value;
  return undefined;
}
