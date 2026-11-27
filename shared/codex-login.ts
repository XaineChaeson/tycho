import type { ModelInfo } from '../adapters/types.ts';
import { localeMap, onLocaleChange, t } from './i18n.ts';
import type { ExecutorIdentity } from './logins.ts';

export const CODEX_LOGIN_STATES = ['starting', 'waiting', 'signed_in', 'failed', 'cancelled'] as const;
export type CodexLoginState = (typeof CODEX_LOGIN_STATES)[number];

export const CODEX_LOGIN_REASONS = ['no_cli', 'start_failed', 'unreadable', 'exit', 'invalid_auth', 'timeout', 'not_saved', 'stopped'] as const;
export type CodexLoginReason = (typeof CODEX_LOGIN_REASONS)[number];

export const CODEX_LOGIN_STATE_TEXT: Readonly<Record<CodexLoginState, string>> = localeMap({
  starting: 'sh.codexLogin.state.starting',
  waiting: 'sh.codexLogin.state.waiting',
  signed_in: 'sh.codexLogin.state.signed_in',
  failed: 'sh.codexLogin.state.failed',
  cancelled: 'sh.codexLogin.state.cancelled',
});

export const CODEX_LOGIN_FAIL_TEXT: Readonly<Record<CodexLoginReason, string>> = localeMap({
  no_cli: 'sh.codexLogin.fail.no_cli',
  start_failed: 'sh.codexLogin.fail.start_failed',
  unreadable: 'sh.codexLogin.fail.unreadable',
  exit: 'sh.codexLogin.fail.exit',
  invalid_auth: 'sh.codexLogin.fail.invalid_auth',
  timeout: 'sh.codexLogin.fail.timeout',
  not_saved: 'sh.codexLogin.fail.not_saved',
  stopped: 'sh.codexLogin.fail.stopped',
});

export const codexLoginLive = (state: CodexLoginState): boolean => state === 'starting' || state === 'waiting';

export interface CodexLoginView {
  id: string;
  account: string;
  name: string;
  mode: 'new' | 'relogin';
  state: CodexLoginState;
  url: string | null;
  code: string | null;
  reason: CodexLoginReason | null;
  saved: boolean;
  ended: boolean;
  unconfirmed: boolean;
  deadline: string;
  models: { list: ModelInfo[]; at: string | null; refreshing: boolean; reason: string | null };
  identity: ExecutorIdentity;
  duplicate: string | null;
}

export const duplicateCodexAccountText = (account: string): string =>
  t('sh.codexLogin.duplicate', { account });

export let NO_DEVICE_LOGIN_TEXT: string = t('sh.codexLogin.noDeviceLogin');
export let CODEX_UNCONFIRMED_TEXT: string = t('sh.codexLogin.unconfirmed');

onLocaleChange(() => {
  NO_DEVICE_LOGIN_TEXT = t('sh.codexLogin.noDeviceLogin');
  CODEX_UNCONFIRMED_TEXT = t('sh.codexLogin.unconfirmed');
});
