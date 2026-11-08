import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { Intent, ScreenId } from '../contracts/ui';

/**
 * Every component emits the contract's Intent shape
 * ({ screen, action, itemId, values }). Transport, permissions and
 * persistence stay outside ui; this context only forwards intent.
 */
type Values = Record<string, string | boolean>;
export type Emit = (screen: ScreenId, action: string, itemId?: string, values?: Values) => Promise<void>;

const Ctx = createContext<(i: Intent) => Promise<void>>(async () => {});

export function IntentProvider({ onIntent, children }: { onIntent: (i: Intent) => Promise<void>; children: ReactNode }) {
  return <Ctx.Provider value={onIntent}>{children}</Ctx.Provider>;
}

export function useEmit(): Emit {
  const onIntent = useContext(Ctx);
  return useCallback((screen, action, itemId, values = {}) => onIntent({ screen, action, itemId, values }), [onIntent]);
}
