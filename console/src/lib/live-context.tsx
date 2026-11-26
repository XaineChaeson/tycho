import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Live, LiveState } from './live.ts';

export const LiveContext = createContext<Live | null>(null);

export function useLive(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error('useLive outside the console');
  return live;
}

export function useLiveState(): LiveState {
  const live = useLive();
  return useSyncExternalStore(live.subscribe, live.getState);
}
