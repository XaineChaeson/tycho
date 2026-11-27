import type { ModelInfo } from '../adapters/types.ts';
import { localeMap, onLocaleChange, t } from './i18n.ts';
import type { ExecutorIdentity } from './logins.ts';

// Signing in to a Claude account from the console (docs/design/native-login.md §二): the
// states a login session goes through and the few reasons it can fail, in the owner's words.
// The service and the console both read these, so the page never says anything the service
// would not, and never shows the CLI's own output.

export const LOGIN_STATES = ['preparing', 'waiting_code', 'exchanging', 'signed_in', 'failed', 'cancelled'] as const;
export type LoginState = (typeof LOGIN_STATES)[number];

export const FAIL_REASONS = ['rejected', 'unreachable', 'unrecognized', 'blocked', 'no_cli', 'start_failed', 'timeout', 'not_saved', 'stopped'] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

export const LOGIN_STATE_TEXT: Readonly<Record<LoginState, string>> = localeMap({
  preparing: 'sh.claudeLogin.state.preparing',
  waiting_code: 'sh.claudeLogin.state.waiting_code',
  exchanging: 'sh.claudeLogin.state.exchanging',
  signed_in: 'sh.claudeLogin.state.signed_in',
  failed: 'sh.claudeLogin.state.failed',
  cancelled: 'sh.claudeLogin.state.cancelled',
});

export const FAIL_TEXT: Readonly<Record<FailReason, string>> = localeMap({
  rejected: 'sh.claudeLogin.fail.rejected',
  unreachable: 'sh.claudeLogin.fail.unreachable',
  unrecognized: 'sh.claudeLogin.fail.unrecognized',
  blocked: 'sh.claudeLogin.fail.blocked',
  no_cli: 'sh.claudeLogin.fail.no_cli',
  start_failed: 'sh.claudeLogin.fail.start_failed',
  timeout: 'sh.claudeLogin.fail.timeout',
  not_saved: 'sh.claudeLogin.fail.not_saved',
  stopped: 'sh.claudeLogin.fail.stopped',
});

// The states in which the session still has something running or held.
export const loginLive = (state: LoginState): boolean => state === 'preparing' || state === 'waiting_code' || state === 'exchanging';

// A login session as the service answers about it. `url` is whole: the owner opens it.
// `shape` is the screen with every letter and digit replaced, for a result that could not be
// read; it holds nothing the screen said.
export interface LoginView {
  id: string;
  account: string;
  name: string;
  mode: 'new' | 'relogin';
  state: LoginState;
  url: string | null;
  reason: FailReason | null;
  shape: string | null;
  // The token is stored: the account's login replaced, or the new account made.
  saved: boolean;
  // Whether the login's processes are confirmed gone. Not confirmed after the wait: the page
  // says "尚未确认结束", and what was recorded about them is kept.
  ended: boolean;
  unconfirmed: boolean;
  deadline: string;
  models: { list: ModelInfo[]; at: string | null; refreshing: boolean; reason: string | null };
  identity: ExecutorIdentity;
  duplicate: string | null;
}

export const duplicateAccountText = (account: string): string => t('sh.claudeLogin.duplicate', { account });

// An executor that says its account is signed in to on its own page, on a service that has no
// login session for it.
export let NO_PAGE_LOGIN_TEXT: string = t('sh.claudeLogin.noPageLogin');
export let UNSUPPORTED_TEXT: string = t('sh.claudeLogin.unsupported');
export let UNCONFIRMED_TEXT: string = t('sh.claudeLogin.unconfirmed');

onLocaleChange(() => {
  NO_PAGE_LOGIN_TEXT = t('sh.claudeLogin.noPageLogin');
  UNSUPPORTED_TEXT = t('sh.claudeLogin.unsupported');
  UNCONFIRMED_TEXT = t('sh.claudeLogin.unconfirmed');
});
