import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// A few choices that are all in sight at once. Radios under the labels, so the keyboard, a
// screen reader and a form all see the control they expect; the chosen one is lifted.
function Segmented<T extends string>({ label, value, options, onChange, disabled = false, className }: {
  label: string;
  value: T | '';
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} data-slot="segmented" className={cn('inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-hover p-0.5', className)}>
      {options.map((option) => (
        <label
          key={option.value}
          title={option.title}
          className={cn(
            'flex min-h-[calc(var(--hit)-4px)] cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors duration-100',
            'has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-ring has-disabled:cursor-not-allowed',
            value === option.value ? 'bg-raised font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <input type="radio" className="sr-only" name={name} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export { Segmented };
