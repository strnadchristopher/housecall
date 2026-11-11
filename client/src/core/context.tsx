import { createContext, useContext, type ReactNode } from "react";
import type { ChatStore } from "./chat";
import type { CallTransport } from "./call";
import type { IdentityProvider } from "./identity";
import type { ChordRegistry } from "./chords";

/** The four seams, handed to the UI by whichever adapter is mounted. */
export interface Backend {
  chat: ChatStore;
  call: CallTransport;
  identity: IdentityProvider;
  chords: ChordRegistry;
}

const BackendContext = createContext<Backend | undefined>(undefined);

export function BackendProvider({ value, children }: { value: Backend; children: ReactNode }) {
  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>;
}

function useBackend(): Backend {
  const backend = useContext(BackendContext);
  if (!backend) throw new Error("No backend adapter is mounted");
  return backend;
}

export const useChat = (): ChatStore => useBackend().chat;
export const useCall = (): CallTransport => useBackend().call;
export const useIdentity = (): IdentityProvider => useBackend().identity;
export const useChords = (): ChordRegistry => useBackend().chords;
