"use client";

import { createContext, useContext } from "react";
import type { AskFootprint } from "./UndoBar";

/**
 * What the page under the Ask window needs to know about it, now that the page stays live while Ask is
 * open: whether Ask is busy (its writes then wait: one write at a time) and what Ask shows at the
 * bottom of the screen (an Undo bar sits above it). Provided by MonsoonApp; outside it, Ask is closed.
 */
export type AskPage = { askBusy: boolean; above: AskFootprint };

export const AskPageContext = createContext<AskPage>({ askBusy: false, above: "pill" });

export function useAskPage(): AskPage {
  return useContext(AskPageContext);
}
