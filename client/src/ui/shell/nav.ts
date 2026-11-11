import { createContext, useContext } from "react";
import type { ChordId } from "../../core/chords";

/** Presentation state only: which view, which side panel, which phone screen. */
export type SettingsSection = "account" | "devices" | "notifications" | "call" | "report" | "server" | "invites" | "channels" | "roles" | "reports" | "about";
export type Side = { kind: "tabs"; tab: "people" | "chords" } | { kind: "chord"; id: ChordId } | { kind: "search" } | { kind: "pins" };

export interface Nav {
  left: "channels" | "dm";
  main: "chat" | "settings";
  section: SettingsSection;
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
