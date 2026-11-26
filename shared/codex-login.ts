import type { ModelInfo } from '../adapters/types.ts';
import type { ExecutorIdentity } from './logins.ts';

export const CODEX_LOGIN_STATES = ['starting', 'waiting', 'signed_in', 'failed', 'cancelled'] as const;
export type CodexLoginState = (typeof CODEX_LOGIN_STATES)[number];

export const CODEX_LOGIN_REASONS = ['no_cli', 'start_failed', 'unreadable', 'exit', 'invalid_auth', 'timeout', 'not_saved', 'stopped'] as const;
export type CodexLoginReason = (typeof CODEX_LOGIN_REASONS)[number];

export const CODEX_LOGIN_STATE_TEXT: Record<CodexLoginState, string> = {
  starting: '正在启动登录',
  waiting: '等你输入设备码授权',
  signed_in: '已登录',
  failed: '没有登录成功',
  cancelled: '已取消',
};

export const CODEX_LOGIN_FAIL_TEXT: Record<CodexLoginReason, string> = {
  no_cli: '主机上找不到 Codex 命令（codex）',
  start_failed: '登录程序没能启动',
  unreadable: '登录程序一直没给出授权网址和设备码，可能这一版的输出格式变了',
  exit: '登录程序没有成功就退出了，请再试一次',
  invalid_auth: '登录程序退出了，但没有生成可用的 ChatGPT 授权令牌',
  timeout: '等太久，这次设备码授权已作废，请再试一次',
  not_saved: '新令牌没能存下来，原来的登录没动',
  stopped: '服务停止或升级，这次登录已中断',
};

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
  `这次授权拿到的 ChatGPT 账号和账号 ${account} 是同一个，不能另建；要更新 ${account} 的登录请对它点“重新登录”`;

export const NO_DEVICE_LOGIN_TEXT = '这个服务还没有启用主机侧设备码登录';
export const CODEX_UNCONFIRMED_TEXT = '登录程序尚未确认结束：tycho 已记下它的进程，服务日志里有编号';
