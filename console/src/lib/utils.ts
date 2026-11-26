import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The theme's own sizes, so that a size given by a caller replaces the component's and
// is not taken for a colour.
const merge = extendTailwindMerge({
  extend: { theme: { spacing: ['hit', 'hit-sm'], text: ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'], radius: ['xs', 'sm', 'md', 'lg', 'xl', '2xl'], shadow: ['xs', 'sm', 'pop', 'dialog'] } },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
