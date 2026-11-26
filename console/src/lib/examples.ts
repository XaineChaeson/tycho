import { useNavigate } from 'react-router';
import { useLive } from '@/lib/live-context';

// The examples an empty page offers. Pressing one puts its sentence in the box of a
// project's conversation and goes there; nothing is sent.
export const EXAMPLE_ASKS = [
  '现在有哪些事在等我？',
  '把这周的进展整理一份给我',
  '这个仓库的测试为什么这么慢？查一查',
];

// A message goes to one project's Router, so the sentence is begun in that project's box.
export function useAsk(project: string) {
  const live = useLive();
  const navigate = useNavigate();
  return (text: string): void => {
    live.typeFor(project, text);
    void navigate(`/projects/${encodeURIComponent(project)}`, { state: { compose: true } });
  };
}
