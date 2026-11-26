// Claude uses these names for the same Fable weekly window.
export function claudeQuotaWindow(window: string): string {
  return window === '7d_oi' || window === 'seven_day_overage_included' ? 'seven_day_fable' : window;
}
