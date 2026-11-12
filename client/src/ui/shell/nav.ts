import { createContext, useContext } from "react";
import type { ChordId } from "../../core/chords";

/** Presentation state only: which view, which side panel, which phone screen. */
export type SettingsSection = "account" | "appearance" | "devices" | "notifications" | "call" | "report" | "server" | "invites" | "channels" | "roles" | "reports" | "integrations" | "about";
export type SideTab = "chat" | "people" | "chords";
export type Side = { kind: "tabs"; tab: SideTab } | { kind: "chord"; id: ChordId } | { kind: "search" } | { kind: "pins" };

/** The call stage owns the center while you are in (or joining) a call and are looking at that call's conversation. */
export function isStaged(call: { phase: string; conversationId?: string }, currentId: string | undefined, main: "chat" | "settings"): boolean {
  return main === "chat" && (call.phase === "live" || call.phase === "connecting") && !!currentId && call.conversationId === currentId;
}

/** Tabs shown in the right column. Chat is a tab only while you are in a call and its stage owns the center. */
export function sideTabs(inCall: boolean, chordsConfigured: boolean): SideTab[] {
  return [...(inCall ? ["chat" as const] : []), "people", ...(chordsConfigured ? ["chords" as const] : [])];
}

export interface Nav {
  left: "channels" | "dm";
  main: "chat" | "settings";
  /** null = the settings root: on a phone the list of sections, on wide screens the first section. */
  section: SettingsSection | null;
  side: Side;
  /** Phone only: which screen of the stack is on top, and whether the side sheet is up. */
  screen: "list" | "main";
  sheet: boolean;
}

export interface NavApi extends Nav {
  set(next: Partial<Nav>): void;
}

export const NavContext = createContext<NavApi | undefined>(undefined);

export function useNav(): NavApi {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("Nav is provided by AppShell");
  return nav;
}
