// The settings of one data directory: the registry, plus the rules that tie an item to
// that directory or to another item.
import { backupDirProblem } from './backup.ts';
import { targetProblem, wssProblem } from './gateway.ts';
import type { Ledger } from './ledger.ts';
import { readSecret, wecomSecretFile } from './secrets.ts';
import type { Settings, SettingsOptions } from './settings.ts';
import { createSettings, DISPATCH_ORDER_KEYS } from './settings.ts';
import type { SettingKey } from './settings.ts';
import { isTierId, tierNamesText } from '../shared/tiers.ts';
import { knowledgeLimitsOf, type KnowledgeLimits } from './knowledge.ts';

interface ServiceSettingsOptions {
  ledger: Ledger;
  dataDir: string;
  log?: SettingsOptions['log'];
}

export function serviceSettings({ ledger, dataDir, log }: ServiceSettingsOptions): Settings {
  // Every list of logins is held to the logins this data directory has: a removed one is
  // passed over where it is used, but one typed in now has to exist.
  const knownLogins = (ids: unknown): string | null => {
    const known = new Set([...ledger.listAccounts(), ...ledger.listMachineLogins()].map(({ id }) => id));
    const unknown = (ids as string[]).filter((id) => !known.has(id));
    return unknown.length === 0 ? null : `没有这个登录：${unknown.join('、')}`;
  };
  const orderChecks = Object.fromEntries(DISPATCH_ORDER_KEYS.map((key) => [key, knownLogins])) as Partial<Record<SettingKey, (value: unknown) => string | null>>;
  const settings: Settings = createSettings({
    ledger,
    ...(log ? { log } : {}),
    checks: {
      ...orderChecks,
      'backup.dir': (dir) => (dir === '' ? null : backupDirProblem(dataDir, dir as string)),
      // The Router's own tier is one of the two names, or empty for the executor's own
      // default. A value left by an older layout is not written over here: the Router says
      // why it will not start and the page offers to change or clear it.
      'router.tier': (tier) => (tier === '' || (typeof tier === 'string' && isTierId(tier)) ? null : `负责人的档位只能是${tierNamesText}之一`),
      'router.account': (id) => id === '' || (typeof id === 'string' && (ledger.getAccount(id) || ledger.getMachineLoginById(id))) ? null : `账号不存在：${id}`,
      // A channel is switched on only with what it needs to connect and someone to tell.
      'wecom.botId'(botId) {
        if (botId === '') return null;
        if (readSecret(wecomSecretFile(dataDir)) === '') return '还没有设置企业微信的 Secret：先填 Secret，再填 Bot ID 启用';
        return settings.get('wecom.owner') === '' ? '还没有填接收人：先填接收人，再填 Bot ID 启用' : null;
      },
      'wecom.owner': (owner) =>
        owner === '' && settings.get('wecom.botId') !== '' ? '企业微信启用着，接收人不能为空。要停用，清空 Bot ID' : null,
      'gateway.ssh': (target) => targetProblem(target as string),
      'gateway.wss': (wss) => wssProblem(wss as string),
      // Logins the owner has now; one removed later is passed over where it is used.
      'knowledge.logins': knownLogins,
    },
    derived: {
      // Whoever the channel answers to is who may command through it: the old receiver's
      // place in the whitelist goes to the new one, and names added by hand stay. A list
      // never made is left to the first connect, which makes it.
      'wecom.owner'({ from, to }, ctx) {
        const whitelist = ledger.getWhitelist();
        if (!whitelist.wecom) return;
        const others = whitelist.wecom.filter((actor) => actor !== from && actor !== to);
        ledger.setWhitelist({ ...whitelist, wecom: to === '' ? others : [...others, to as string] }, ctx);
      },
    },
  });
  return settings;
}

// The four knowledge limits, read through the settings at the moment of use.
export const knowledgeLimits = (settings: Pick<Settings, 'get'>): KnowledgeLimits => knowledgeLimitsOf((key) => settings.get(key));
