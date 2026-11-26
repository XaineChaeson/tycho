// What every page stands in: a bar at the top that says where this is and holds what can
// be done here, and under it the part that scrolls. What could not be read is said at the
// top and what was read before stays under it; until the first answer the shape of what is
// coming is drawn, so nothing under it moves when it arrives.
import { Menu } from 'lucide-react';
import { createContext, Fragment, useContext, useEffect, type ComponentProps, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Chevron, Problem } from '@/components/bits';
import { PageScroll } from '@/components/page-scroll';
import { Button } from '@/components/ui/button';
import { SkeletonPage } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// The side column is a drawer on a narrow screen, and the button that opens it lives in
// the page's own bar: the shell says how.
export const MenuContext = createContext<{ open: boolean; toggle: () => void; button: React.RefObject<HTMLButtonElement | null>; shutAt: React.RefObject<number> } | null>(null);

// How long after the menu shut a newly drawn bar still takes the focus for its button.
const JUST_SHUT_MS = 1000;

function MenuButton() {
  const menu = useContext(MenuContext);
  // The bar of a page chosen in the menu is drawn after the menu shut: its button is the
  // one that opened it, as far as the owner can tell, and gets the focus back.
  useEffect(() => {
    if (menu && Date.now() - menu.shutAt.current < JUST_SHUT_MS) menu.button.current?.focus();
  }, [menu]);
  if (!menu) return null;
  return (
    <Button ref={menu.button} variant="ghost" size="icon" aria-label="菜单" aria-expanded={menu.open} aria-controls="side" className="-ml-1.5 flex-none shell:hidden" onClick={menu.toggle}>
      <Menu />
    </Button>
  );
}

export interface Crumb { label: ReactNode; to?: string }

// Where the page in view sits: 项目 › 工作 › 任务. Every step with an address leads back.
export function Crumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="所在位置" className={cn('flex min-w-0 items-center gap-1 text-sm text-muted-foreground', className)}>
      {items.map((item, index) => (
        <Fragment key={index}>
          {index ? <Chevron className="size-3.5" /> : null}
          {item.to
            ? <Link to={item.to} className="max-w-[28ch] flex-none truncate rounded-sm no-underline hover:text-foreground">{item.label}</Link>
            : <span aria-current={index === items.length - 1 ? 'page' : undefined} className="min-w-0 truncate text-foreground">{item.label}</span>}
        </Fragment>
      ))}
    </nav>
  );
}

// The bar at the top of a page. A page that is a place of its own is named by `title`; one
// that is a thing inside a place (a task, an entry) shows the way back and names itself in
// its body. `children` is a second line: the page's tabs.
export function PageBar({ title, crumbs, actions, children, badge, className }: {
  title?: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
  children?: ReactNode;
  // A mark of what this page's object is, beside its name: an archived project.
  badge?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (title === undefined) return undefined;
    document.title = `${title} · tycho`;
    return () => { document.title = 'tycho'; };
  }, [title]);
  return (
    <header data-slot="page-bar" className={cn('flex-none border-b border-border bg-muted/65', className)}>
      <div className="flex min-h-11 items-center gap-2 px-3.5 shell:px-4">
        <MenuButton />
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {crumbs?.length ? <Crumbs items={crumbs} className={title === undefined ? 'flex-1' : 'hidden flex-none sm:flex'} /> : null}
          {crumbs?.length && title !== undefined ? <Chevron className="hidden size-3.5 sm:block" /> : null}
          {title === undefined ? null : <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">{title}</h1>}
          {badge ? <span className="flex flex-none items-center">{badge}</span> : null}
        </div>
        {actions ? <div className="flex flex-none items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

// A page's tabs: each is an address, so a link to one opens it and the back button leaves it.
// A tab whose address differs from its neighbour's only after the "?" says itself whether it
// is the one in view (`current`); the others are told by their path.
export function PageTabs({ label, tabs }: { label: string; tabs: { to: string; label: ReactNode; count?: number | undefined; current?: boolean }[] }) {
  const { pathname } = useLocation();
  return (
    <nav aria-label={label} className="-mb-px flex gap-1 overflow-x-auto px-2.5 shell:px-3.5">
      {tabs.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          aria-current={(tab.current ?? decodeURIComponent(pathname) === decodeURIComponent(tab.to)) ? 'page' : undefined}
          className="group/tab flex min-h-9 flex-none items-center gap-1.5 border-b-2 border-transparent px-1.5 text-sm text-muted-foreground no-underline hover:text-foreground focus-visible:-outline-offset-2 aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground"
        >
          {tab.label}
          {tab.count ? <span className="rounded-full bg-waiting-soft px-1.5 text-xs leading-[18px] font-medium text-waiting-foreground tabular-nums">{tab.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

const WIDTHS = { narrow: 'max-w-[760px]', default: 'max-w-[1040px]', wide: 'max-w-[1360px]' };

// The part of a page under its bar. A title, a path, a machine or a branch name can be one
// long word: it breaks anywhere rather than push the page wider than the screen.
export function PageBody({ width = 'default', follow, opens, loading = false, failure, className, children }: {
  width?: keyof typeof WIDTHS;
  // Whether the page goes down with what is added at its end, once the reader is there.
  follow?: boolean;
  opens?: 'head' | 'latest';
  loading?: boolean;
  failure?: string | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <PageScroll follow={follow} opens={opens}>
      <div className={cn('mx-auto px-4 pt-5 pb-10 wrap-anywhere shell:px-6 shell:pt-6 shell:pb-12', WIDTHS[width], className)}>
        {failure ? <Problem role="alert" className="mb-3">{failure}</Problem> : null}
        {loading ? <SkeletonPage /> : children}
      </div>
    </PageScroll>
  );
}

// The common page: a bar, and a body that scrolls.
export function Page({ title, crumbs, actions, tabs, ...body }: ComponentProps<typeof PageBody> & {
  title?: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
  tabs?: ReactNode;
}) {
  return (
    <>
      <PageBar title={title} crumbs={crumbs} actions={actions}>{tabs}</PageBar>
      <PageBody {...body} />
    </>
  );
}

// One sentence at the head of a page's body, in the reader's words, about what the page is for.
export function PageLead({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('mb-5 max-w-[72ch] text-sm text-muted-foreground', className)} {...props} />;
}

// The name of a thing at the head of its own page: a task, a work, an entry.
export function PageTitle({ className, ...props }: ComponentProps<'h1'>) {
  return <h1 className={cn('text-2xl font-semibold tracking-[-0.01em] wrap-anywhere', className)} {...props} />;
}
