// One change at a time to a list the console shows, for as long as the console is open.
// The settings page and the machines page both save this way: each answer is the list
// as the service left it, so no two answers can arrive out of order and the older undo
// the newer. The lock is the console's, not the page's: a change sent before the owner
// left the page holds the next one until it is answered, also once they are back.
import { useIsMutating, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { onLocaleChange, t } from '@shared/i18n.ts';
import { useMounted } from '@/hooks/use-mounted';

interface Change<Page> {
  request: () => Promise<unknown>;
  // What the answer makes of the list, so no read decides what a change that is in
  // leaves on the page.
  taken: (page: Page, answer: unknown) => Page;
}

export function earlierChangeText(): string {
  return t('core.change.earlier');
}

// Said by a page that finds a change on its way and has no row of its own that says so.
export let EARLIER_CHANGE = t('core.change.earlier');
onLocaleChange(() => {
  EARLIER_CHANGE = t('core.change.earlier');
});

export function useChange<Page>({ mutationKey, queryKey, reread = false }: {
  mutationKey: QueryKey;
  queryKey: QueryKey;
  // Whether the list is read again after a change is in, for what else moved meanwhile.
  reread?: boolean;
}) {
  const client = useQueryClient();
  const here = useMounted();
  const busy = useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation({
    mutationKey,
    mutationFn: ({ request }: Change<Page>) => request(),
    // Here and not where it was sent from: the answer is put on the list also when the
    // page that sent it is gone.
    onSuccess: async (answer, { taken }) => {
      // A read sent before this answer is older than it. Awaited: a read cancelled
      // later would put the list from before it back.
      await client.cancelQueries({ queryKey });
      client.setQueryData<Page>(queryKey, (page) => (page ? taken(page, answer) : page));
      // That this read fails takes nothing back.
      if (reread) void client.invalidateQueries({ queryKey });
    },
    // Nothing on the page says how a refused change ended once the row that sent it is
    // gone: read.
    onError: () => {
      if (!here()) void client.invalidateQueries({ queryKey });
    },
  });

  return {
    // A change is on its way, from this page or from before the owner left it.
    busy,
    // Asked of the console, not of what this page last drew: the second submit can come
    // before the page is drawn again.
    free: (): boolean => client.isMutating({ mutationKey }) === 0,
    // Throws what the service refused it with.
    send: <Answer>(request: () => Promise<Answer>, taken: (page: Page, answer: Answer) => Page): Promise<unknown> =>
      mutation.mutateAsync({ request, taken: taken as Change<Page>['taken'] }),
  };
}
