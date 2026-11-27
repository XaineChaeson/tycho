// Signing a machine in to one of its executors from the console (docs/design/native-login.md):
// the states such a sign-in goes through and the few reasons it can fail, in the owner's words.
// The service and the console both read these, so the page never says anything the service
// would not, and never shows the command's own output.
import { localeMap, onLocaleChange, t } from './i18n.ts';
import type { NodeSignInReason, NodeSignInState } from './node-protocol.ts';

export type SignInState = NodeSignInState;

// The machine's own reasons, and the host's: it could not hand the command over, heard nothing
// back in time, or stopped.
export type SignInReason = NodeSignInReason | 'not_delivered' | 'no_echo' | 'stopped';

export const SIGN_IN_STATE_TEXT: Readonly<Record<SignInState, string>> = localeMap({
  starting: 'sh.signIn.state.starting',
  waiting: 'sh.signIn.state.waiting',
  exchanging: 'sh.signIn.state.exchanging',
  done: 'sh.signIn.state.done',
  failed: 'sh.signIn.state.failed',
  cancelled: 'sh.signIn.state.cancelled',
});

export const SIGN_IN_REASON_TEXT: Readonly<Record<SignInReason, string>> = localeMap({
  missing: 'sh.signIn.reason.missing',
  exit: 'sh.signIn.reason.exit',
  timeout: 'sh.signIn.reason.timeout',
  unreadable: 'sh.signIn.reason.unreadable',
  not_delivered: 'sh.signIn.reason.not_delivered',
  no_echo: 'sh.signIn.reason.no_echo',
  stopped: 'sh.signIn.reason.stopped',
});

export let NO_MACHINE_SIGN_IN_TEXT: string = t('sh.signIn.noMachineSignIn');

onLocaleChange(() => {
  NO_MACHINE_SIGN_IN_TEXT = t('sh.signIn.noMachineSignIn');
});

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
