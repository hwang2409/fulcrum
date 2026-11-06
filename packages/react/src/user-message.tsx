import type { CSSProperties, ReactNode } from "react";

/** The one prompt/content structure shared by every user-message renderer. */
export function UserMessageContent({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <><span data-part="message-prompt" aria-hidden="true">{"> "}</span><div data-part="message-content" style={style}>{children}</div></>;
}
