// Signing a machine in to one of its executors from the console (docs/design/native-login.md):
// the states such a sign-in goes through and the few reasons it can fail, in the owner's words.
// The service and the console both read these, so the page never says anything the service
// would not, and never shows the command's own output.
import type { NodeSignInReason, NodeSignInState } from './node-protocol.ts';

export type SignInState = NodeSignInState;

// The machine's own reasons, and the host's: it could not hand the command over, heard nothing
// back in time, or stopped.
export type SignInReason = NodeSignInReason | 'not_delivered' | 'no_echo' | 'stopped';

export const SIGN_IN_STATE_TEXT: Record<SignInState, string> = {
  starting: '正在启动登录',
  waiting: '等你去授权',
  exchanging: '正在验证授权码',
  done: '已登录',
  failed: '没有登录成功',
  cancelled: '已取消',
};

export const SIGN_IN_REASON_TEXT: Record<SignInReason, string> = {
  missing: '那台机器上找不到这个执行器的登录命令',
  exit: '登录程序没有成功就退出了，再试一次',
  timeout: '等太久，这次的用户码已作废，再试一次',
  unreadable: '登录程序一直没给出网址和用户码，可能这一版的画面认不出来',
  not_delivered: '登录命令没送到那台机器（它可能刚掉线）',
  no_echo: '那台机器没有回音，这次登录已作废',
  stopped: '服务停止或升级，这次登录已中断',
};

export const NO_MACHINE_SIGN_IN_TEXT = '这个服务不能在机器上发起登录';

export const signInLive = (state: SignInState): boolean => state === 'starting' || state === 'waiting' || state === 'exchanging';

// A sign-in as the service answers about it. `url` and `code` are what the owner opens and types
// in their own browser; `accepts_code` is true when the CLI expects an authorization code pasted
// back; `signed_in` is what the machine last reported about this executor's login.
export interface SignInView {
  id: string;
  machine: string;
  executor: string;
  state: SignInState;
  url: string | null;
  code: string | null;
  accepts_code?: boolean;
  reason: string | null;
  signed_in: boolean | null;
}
