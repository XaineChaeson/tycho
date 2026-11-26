// The small pieces every page is made of: a state's dot and its badge, a time, a line of
// gray text, a value that can be copied, a section that folds, a list of rows, a pair of
// label and value, and what a place says when it holds nothing.
import { Check, ChevronRight, Copy, X } from 'lucide-react';
import { useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { taskDotClasses, taskStateLabels } from '@shared/labels.ts';
import { formatTime, fullTime } from '@shared/time.ts';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// The five things a colour says. A dot never stands alone: the words beside it say the
// same, so the colour is not the only carrier.
export type Tone = 'running' | 'waiting' | 'failed' | 'success' | 'ended';

const DOTS: Record<Tone, string> = {
  running: 'bg-running',
  waiting: 'bg-waiting',
  failed: 'bg-failed',
  success: 'bg-success',
  ended: 'bg-ended',
};

// What a Task's state means in those five. The service's own table says moving, waiting,
// wrong or over; of the two ways to be over, the one that was accepted is green.
export function toneOf(state: string | undefined): Tone {
  if (state === 'done') return 'success';
  const tone = taskDotClasses[state ?? ''];
  return tone === 'running' || tone === 'waiting' || tone === 'failed' ? tone : 'ended';
}

export function Dot({ tone, pulse, title, className }: { tone: Tone | undefined; pulse?: boolean; title?: string; className?: string }) {
  const shown = tone ?? 'ended';
  return (
    <span
      data-tone={shown}
      className={cn('inline-block size-2 flex-none rounded-full', DOTS[shown], (pulse ?? shown === 'running') && 'animate-breathe', className)}
      {...(title ? { title, role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    />
  );
}

const MARKS: Record<Tone, string> = {
  running: 'text-running',
  waiting: 'text-waiting',
  failed: 'text-failed',
  success: 'text-success',
  ended: 'text-ended',
};

// A Task's state as a small sign, drawn so that the shape alone tells the states apart:
// a turning arc is at work, a ring is in line, a question waits for an answer, a filled
// ring waits to be accepted, bars are a stop, a tick is done. The colour is the state's;
// the words beside it say the same.
export function StatusDot({ state, className }: { state: string; className?: string }) {
  const tone = toneOf(state);
  const ring = <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />;
  const disc = <circle cx="8" cy="8" r="7" fill="currentColor" />;
  const white = { fill: 'none', stroke: 'var(--background)', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  const shape = (() => {
    switch (state) {
      case 'running':
        return (
          <>
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
            <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="origin-center animate-turn" />
          </>
        );
      case 'stopping':
        return <>{ring}<rect x="5.75" y="5.75" width="4.5" height="4.5" rx="1" fill="currentColor" /></>;
      case 'queued':
        return <>{ring}<circle cx="8" cy="8" r="1.5" fill="currentColor" /></>;
      case 'waiting_timer':
        return <>{ring}<path d="M8 4.75V8l2 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>;
      case 'needs_verification':
        return <><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.3" /><circle cx="8" cy="8" r="1.5" fill="currentColor" className="origin-center animate-breathe" /></>;
      case 'ready':
        return <>{ring}<circle cx="8" cy="8" r="3.5" fill="currentColor" /></>;
      case 'waiting_person':
        return <>{disc}<path d="M6.3 6.4a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3" {...white} /><circle cx="8" cy="11.6" r="0.9" fill="var(--background)" /></>;
      case 'held':
        return <>{disc}<path d="M6.4 5.6v4.8M9.6 5.6v4.8" {...white} /></>;
      case 'done':
        return <>{disc}<path d="m5 8.2 2.1 2.1L11 6" {...white} /></>;
      case 'abandoned':
        return <>{disc}<path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" {...white} /></>;
      default:
        return <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.3" />;
    }
  })();
  return (
    <svg viewBox="0 0 16 16" data-tone={tone} data-state={state} aria-hidden="true" className={cn('size-4 flex-none', MARKS[tone], className)}>
      {shape}
    </svg>
  );
}

// A project's own mark: the first character of its name on a tile whose hue is worked out
// from the name, so a project is the same colour wherever it shows.
export function ProjectMark({ name, className }: { name: string; className?: string }) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return (
    <span aria-hidden="true" style={{ '--hue': hash } as CSSProperties} className={cn('project-mark inline-flex size-5 flex-none items-center justify-center rounded-sm text-2xs leading-none font-semibold', className)}>
      {[...name.trim()][0]?.toUpperCase() ?? '·'}
    </span>
  );
}

// What an empty place is drawn with: a few orbits and the bodies on them. tycho is named
// for an astronomer; the picture says "nothing here yet" without a sad face.
export function Orbits({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 96" aria-hidden="true" className={cn('h-24 w-40 text-border-strong', className)}>
      <ellipse cx="80" cy="48" rx="74" ry="26" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 4" />
      <ellipse cx="80" cy="48" rx="50" ry="17" fill="none" stroke="currentColor" strokeWidth="1" />
      <ellipse cx="80" cy="48" rx="26" ry="9" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 4" />
      <circle cx="80" cy="48" r="5" className="fill-primary" />
      <circle cx="80" cy="48" r="9" className="fill-primary" opacity="0.15" />
      <circle cx="124" cy="40" r="3.5" className="fill-waiting" />
      <circle cx="40" cy="58" r="2.5" className="fill-success" />
      <circle cx="146" cy="60" r="2" fill="currentColor" />
      <circle cx="58" cy="42" r="1.5" fill="currentColor" />
    </svg>
  );
}

// A Task's state as a word, in the colour of what it means.
export function StateBadge({ state, className }: { state: string; className?: string }) {
  return <Badge tone={toneOf(state) as BadgeTone} className={className}>{taskStateLabels[state] ?? state}</Badge>;
}

export function Time({ at, prefix = '', suffix = '', className }: { at: string | number | null | undefined; prefix?: string; suffix?: string; className?: string }) {
  return (
    <time dateTime={typeof at === 'string' ? at : at == null ? '' : new Date(at).toISOString()} title={fullTime(at)} className={cn('tabular-nums', className)}>
      {prefix}{formatTime(at)}{suffix}
    </time>
  );
}

// What explains: one strength below what is read.
export function Note({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground wrap-anywhere', className)} {...props} />;
}

// What went wrong, in the words the service said it in.
export function Problem({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-destructive wrap-anywhere', className)} {...props} />;
}

export const Chevron = ({ className }: { className?: string }) => <ChevronRight className={cn('size-4 flex-none text-faint', className)} aria-hidden="true" />;

// A value the owner may need elsewhere: monospace, so the characters are told apart.
export function Mono({ className, children, ...props }: ComponentProps<'code'>) {
  return <code className={cn('font-mono text-xs wrap-anywhere', className)} {...props}>{children}</code>;
}

// An identifier, a path or a command, copyable with one press. The button says what it did
// for a moment and then goes back to what it does — and it says "copied" only when the
// clipboard took the value: a browser that refuses the write (or has no clipboard at all) is
// told apart, and the value is still there to select by hand.
const REFUSED = '浏览器不让网页写剪贴板：选中这段文字，自己复制';

export function CopyButton({ value, label = '复制', className }: { value: string; label?: string; className?: string }) {
  const [said, setSaid] = useState<'copied' | 'refused' | null>(null);
  const back = useRef<number | undefined>(undefined);
  async function copy(): Promise<void> {
    window.clearTimeout(back.current);
    try {
      await navigator.clipboard.writeText(value);
      setSaid('copied');
      back.current = window.setTimeout(() => setSaid(null), 1500);
    } catch {
      // Nothing was copied, so nothing may say it was; the reason stays until tried again.
      setSaid('refused');
    }
  }
  const words = said === 'copied' ? '已复制' : said === 'refused' ? '复制不了' : label;
  const Icon = said === 'copied' ? Check : said === 'refused' ? X : Copy;
  return (
    <button
      type="button"
      data-said={said ?? undefined}
      aria-label={said === 'refused' ? `${label}不了：${value}（${REFUSED}）` : `${label}：${value}`}
      title={said === 'refused' ? REFUSED : words}
      className={cn(
        'inline-flex size-6 flex-none items-center justify-center rounded-sm text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground',
        said === 'copied' && 'text-success-foreground', said === 'refused' && 'text-destructive', className,
      )}
      onClick={() => void copy()}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{words}</span>
    </button>
  );
}

// A value in monospace with its copy button, as one piece that wraps together.
export function Copyable({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <Mono>{value}</Mono>
      <CopyButton value={value} />
    </span>
  );
}

// A command to run somewhere else: on its own line, whole, with the copy button at its end.
export function CommandLine({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-md border border-border bg-code py-1.5 pr-1.5 pl-3', className)}>
      <Mono className="min-w-0 flex-1 py-0.5 leading-5">{value}</Mono>
      <CopyButton value={value} />
    </div>
  );
}

// An address the service hands over as "#/settings/…" is a place in the console.
export function HashLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (href.startsWith('#/')) return <Link to={href.slice(1)} className={cn('wrap-anywhere', className)}>{children}</Link>;
  return <a href={href} className={cn('wrap-anywhere', className)}>{children}</a>;
}

// Which sections the owner has opened, kept while the console is: a page that reads again,
// or is come back to, does not close them.
const opened = new Set<string>();

// `lazy`: what is folded away is not drawn at all until it is asked for, for a section whose
// rows are information in their own right rather than something the page already shows.
export function Details({ id, title, open, lazy, className, summaryClassName, children }: { id: string; title: ReactNode; open?: boolean; lazy?: boolean; className?: string; summaryClassName?: string; children: ReactNode }) {
  const [, redraw] = useState(0);
  const shown = open ?? opened.has(id);
  return (
    <details
      className={cn('group/details', className)}
      open={shown}
      onToggle={(event) => {
        if (event.currentTarget.open) opened.add(id); else opened.delete(id);
        redraw((n) => n + 1);
      }}
    >
      <summary className={cn('flex min-h-hit cursor-pointer list-none items-center gap-1.5 text-sm text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden', summaryClassName)}>
        <ChevronRight className="size-3.5 flex-none text-faint transition-transform duration-100 group-open/details:rotate-90" aria-hidden="true" />
        {title}
      </summary>
      {lazy && !shown ? null : children}
    </details>
  );
}

// A group of like things as one bordered box with a hair line between its rows.
export function Rows({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('divide-y divide-border overflow-hidden rounded-xl bg-raised shadow-card', className)} {...props} />;
}

// A group of related things on a page: a fine outline and one rhythm of padding. Drawn
// where a heading alone would not hold the group together; never one inside another.
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('rounded-xl bg-raised p-4 shadow-card', className)} {...props} />;
}

// The small heading over a group of rows or facts.
export function SectionTitle({ className, count, action, children, ...props }: ComponentProps<'h2'> & { count?: number | undefined; action?: ReactNode }) {
  return (
    <div className={cn('mb-2.5 flex min-h-6 items-center gap-2', className)}>
      <h2 className="text-sm font-semibold" {...props}>{children}</h2>
      {count === undefined ? null : <span className="rounded-full bg-hover px-1.5 text-xs leading-[18px] font-medium text-muted-foreground tabular-nums">{count}</span>}
      {action ? <span className="ml-auto flex items-center gap-1">{action}</span> : null}
    </div>
  );
}

// Facts as pairs: what it is on the left in gray, what it is now on the right.
export function Facts({ className, ...props }: ComponentProps<'dl'>) {
  return <dl className={cn('grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]', className)} {...props} />;
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

// A place that holds nothing yet says what will be here and how to begin.
export function Empty({ icon, title, children, className }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center rounded-xl border border-dashed border-border-strong px-6 py-10 text-center', className)}>
      {icon ? <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand-foreground [&_svg]:size-5">{icon}</span> : <Orbits className="mb-2" />}
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 max-w-[52ch] text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

// Something the owner should see before reading on: a wait that needs them (amber), a
// fault (red), or a plain remark (gray).
export function Callout({ tone = 'waiting', title, action, className, children, ...props }: Omit<ComponentProps<'div'>, 'title'> & { tone?: 'waiting' | 'failed' | 'running' | 'plain'; title?: ReactNode; action?: ReactNode }) {
  const look = {
    waiting: 'border-waiting-border bg-waiting-soft',
    failed: 'border-failed-border bg-failed-soft',
    running: 'border-running-border bg-running-soft',
    plain: 'border-border bg-muted',
  }[tone];
  return (
    <div data-tone={tone} className={cn('rounded-lg border px-3.5 py-3 text-sm wrap-anywhere', look, className)} {...props}>
      {title || action ? (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          {title ? <p className="font-semibold">{title}</p> : null}
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}

// A caption above a control, and under it what the control wants or why it was refused.
export function Field({ label, hint, error, htmlFor, className, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; htmlFor?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground wrap-anywhere">{hint}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive wrap-anywhere">{error}</p> : null}
    </div>
  );
}

export const PRE = 'max-w-full overflow-x-auto rounded-md border border-border bg-code p-3 font-mono text-xs leading-[1.65] wrap-anywhere whitespace-pre-wrap';
