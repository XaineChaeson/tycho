import type { ModelInfo } from '../adapters/types.ts';
import type { ExecutorIdentity } from './logins.ts';

// Signing in to a Claude account from the console (docs/design/native-login.md §二): the
// states a login session goes through and the few reasons it can fail, in the owner's words.
// The service and the console both read these, so the page never says anything the service
// would not, and never shows the CLI's own output.

export const LOGIN_STATES = ['preparing', 'waiting_code', 'exchanging', 'signed_in', 'failed', 'cancelled'] as const;
export type LoginState = (typeof LOGIN_STATES)[number];

export const FAIL_REASONS = ['rejected', 'unreachable', 'unrecognized', 'blocked', 'no_cli', 'start_failed', 'timeout', 'not_saved', 'stopped'] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

export const LOGIN_STATE_TEXT: Record<LoginState, string> = {
  preparing: '正在准备',
  waiting_code: '等你授权',
  exchanging: '正在核对授权码',
  signed_in: '已登录',
  failed: '没有登录成功',
  cancelled: '已取消',
};

export const FAIL_TEXT: Record<FailReason, string> = {
  rejected: '授权码未被接受',
  unreachable: '连接不上厂商',
  unrecognized: '认不出这一版的登录结果',
  blocked: '这台机器的系统策略拒绝了登录助手',
  no_cli: '主机上找不到 Claude Code',
  start_failed: '登录程序没能启动',
  timeout: '等太久，这次登录已作废',
  not_saved: '令牌没能存下来，原来的登录没动',
  stopped: '服务停止，这次登录已中断',
};

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

export const duplicateAccountText = (account: string): string => `这次授权拿到的账号和账号 ${account} 属于同一个 Claude 组织，不能另建；要更新 ${account} 的令牌请对它点“重新登录”`;

// An executor that says its account is signed in to on its own page, on a service that has no
// login session for it.
export const NO_PAGE_LOGIN_TEXT = '这个服务还没有这个执行器的官方登录步骤';
export const UNSUPPORTED_TEXT = '此主机暂不支持在控制台登录 Claude：登录助手只在 Windows 主机上有';
export const UNCONFIRMED_TEXT = '登录程序尚未确认结束：tycho 记下了它的进程，服务日志里有编号';
