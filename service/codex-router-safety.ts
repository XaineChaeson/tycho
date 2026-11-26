// Retained as a no-op export for compatibility; Codex Router runs with full native capabilities
// while secret env scrubbing lives in codexRouterEnv below.
export function checkCodexRouterThread(_thread?: unknown, _rows?: unknown, _expectedTools?: readonly string[]): void {}

// The selected managed credential is the only credential passed to the Codex bridge.
export function codexRouterEnv(env: NodeJS.ProcessEnv, token?: string): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CODEX_WINDOWS_REGISTERED_CORE|CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY|CODEX_API_KEY|OPENAI_API_KEY|ANTHROPIC_.*|CLAUDE.*)$/i.test(key)));
  if (token) clean.CODEX_API_KEY = token;
  return clean;
}
