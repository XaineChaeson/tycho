import { useNavigate } from 'react-router';
import { t } from '@shared/i18n.ts';
import { useLive } from '@/lib/live-context';

const EXAMPLE_ASK_KEYS = [
  'core.examples.ask1',
  'core.examples.ask2',
  'core.examples.ask3',
] as const;

export function getExampleAsks(): string[] {
  return EXAMPLE_ASK_KEYS.map((key) => t(key));
}

// The examples an empty page offers. Pressing one puts its sentence in the box of a
// project's conversation and goes there; nothing is sent.
export const EXAMPLE_ASKS: readonly string[] = new Proxy([...EXAMPLE_ASK_KEYS] as string[], {
  get(_target, prop) {
    if (typeof prop === 'string' && /^\d+$/.test(prop)) {
      const idx = Number(prop);
      if (idx >= 0 && idx < EXAMPLE_ASK_KEYS.length) return t(EXAMPLE_ASK_KEYS[idx]!);
    }
    const current = getExampleAsks();
    if (prop === Symbol.iterator) return () => current[Symbol.iterator]();
    const value = Reflect.get(current, prop, current);
    return typeof value === 'function' ? value.bind(current) : value;
  },
  getOwnPropertyDescriptor(target, prop) {
    if (typeof prop === 'string' && /^\d+$/.test(prop)) {
      const idx = Number(prop);
      if (idx >= 0 && idx < EXAMPLE_ASK_KEYS.length) {
        return { enumerable: true, configurable: true, writable: false, value: t(EXAMPLE_ASK_KEYS[idx]!) };
      }
    }
    return Reflect.getOwnPropertyDescriptor(target, prop);
  },
});

// A message goes to one project's Router, so the sentence is begun in that project's box.
export function useAsk(project: string) {
  const live = useLive();
  const navigate = useNavigate();
  return (text: string): void => {
    live.typeFor(project, text);
    void navigate(`/projects/${encodeURIComponent(project)}`, { state: { compose: true } });
  };
}
