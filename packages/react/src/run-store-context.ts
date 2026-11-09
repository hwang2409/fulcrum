import { createContext } from "react";
import type { createRunStore } from "@fulcrum/core";

export type RunStore = Pick<
  ReturnType<typeof createRunStore>,
  | "getState"
  | "getItem"
  | "getOutline"
  | "getOutlineSnapshot"
  | "subscribe"
  | "subscribeOutline"
> & Partial<Pick<ReturnType<typeof createRunStore>, "getDiagnostics" | "subscribeDiagnostics" | "hasMessageDelivery">>;

export const StoreContext = createContext<RunStore | null>(null);
