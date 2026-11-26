// Unified IM channel vocabulary, group binding contracts, validation helpers, and pure Fast-Path evaluation.
// Shared between the service and console so channel names, trigger rules, and bounds never drift.

export const IM_CHANNELS = ['wecom', 'weixin'] as const;
export type ImChannel = (typeof IM_CHANNELS)[number];

export const IM_GROUP_CAPABLE_CHANNELS = ['wecom'] as const;
export type ImGroupCapableChannel = (typeof IM_GROUP_CAPABLE_CHANNELS)[number];

export const IM_CHANNEL_LABELS: Record<ImChannel, string> = {
  wecom: '企业微信',
  weixin: '微信',
};

export const isImChannel = (value: unknown): value is ImChannel =>
  typeof value === 'string' && (IM_CHANNELS as readonly string[]).includes(value);

export const isGroupCapableChannel = (channel: ImChannel): boolean =>
  (IM_GROUP_CAPABLE_CHANNELS as readonly string[]).includes(channel);

export const IM_GROUP_TRIGGER_MODES = ['mention_only', 'mention_or_rules'] as const;
export type ImGroupTriggerMode = (typeof IM_GROUP_TRIGGER_MODES)[number];

export const IM_GROUP_TRIGGER_MODE_LABELS: Record<ImGroupTriggerMode, string> = {
  mention_only: '仅 @ 机器人触发',
  mention_or_rules: '@ 机器人或关键词触发',
};

export const isImGroupTriggerMode = (value: unknown): value is ImGroupTriggerMode =>
  typeof value === 'string' && (IM_GROUP_TRIGGER_MODES as readonly string[]).includes(value);

export interface ImChannelPermissions {
  chat: boolean;
  notify: boolean;
  approve_login: boolean;
}

export interface ImAttachmentRef {
  kind: 'image' | 'file';
  name?: string;
  mime?: string;
  url?: string;
  media_id?: string;
  aes_key?: string;
  size?: number;
}

export interface NormalizedImMessage {
  channel: ImChannel;
  botId: string;
  chatId: string;
  chatType: 'single' | 'group';
  externalId: string;
  actor: string;
  actorName?: string;
  text?: string;
  mentionedBot: boolean;
  replyToExternalId?: string;
  materialSource?: string;
  attachments: ImAttachmentRef[];
  receivedAt?: string;
}

export interface ImGroupBindingView {
  id: string;
  created_at: string;
  updated_at: string;
  channel: ImChannel;
  chat_id: string;
  chat_name: string;
  project_id: string;
  project_name: string;
  enabled: boolean;
  trigger_mode: ImGroupTriggerMode;
  allow_all_senders: boolean;
  allowed_senders: string[];
  rule_keywords: string[];
  cooldown_seconds: number;
  inline_context_count: number;
  accept_media: boolean;
  notify_events: boolean;
  last_triggered_at: string | null;
}

export interface DiscoveredImGroup {
  channel: ImChannel;
  chat_id: string;
  last_seen_at: string;
  last_actor: string;
  last_text: string;
  message_count: number;
}

export interface ImGroupBindingInput {
  channel: ImChannel;
  chat_id: string;
  chat_name?: string;
  project_id: string;
  enabled?: boolean;
  trigger_mode?: ImGroupTriggerMode;
  allow_all_senders?: boolean;
  allowed_senders?: readonly string[];
  rule_keywords?: readonly string[];
  cooldown_seconds?: number;
  inline_context_count?: number;
  accept_media?: boolean;
  notify_events?: boolean;
}

export interface ImGroupBindingPatch {
  chat_name?: string;
  project_id?: string;
  enabled?: boolean;
  trigger_mode?: ImGroupTriggerMode;
  allow_all_senders?: boolean;
  allowed_senders?: readonly string[];
  rule_keywords?: readonly string[];
  cooldown_seconds?: number;
  inline_context_count?: number;
  accept_media?: boolean;
  notify_events?: boolean;
}

export const IM_COOLDOWN_MIN = 0;
export const IM_COOLDOWN_MAX = 86_400;
export const IM_INLINE_CONTEXT_MIN = 0;
export const IM_INLINE_CONTEXT_MAX = 20;
export const IM_RULE_KEYWORDS_MAX = 50;
export const IM_RULE_KEYWORD_MAX_CHARS = 128;
export const IM_RULE_REGEX_MAX_CHARS = 120;
export const IM_ALLOWED_SENDERS_MAX = 200;
export const IM_SENDER_MAX_CHARS = 128;
export const IM_CHAT_ID_MAX_CHARS = 128;
export const IM_CHAT_NAME_MAX_CHARS = 100;

const ALLOWED_REGEX_FLAGS = new Set(['i', 'm', 'u']);
const REGEX_LITERAL_RE = /^\/(.*)\/([a-zA-Z]*)$/;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const IM_RULE_MAX_QUANTIFIER_BOUND = 100;
const IM_RULE_MAX_UNBOUNDED_QUANTIFIERS = 3;
const IM_FAST_PATH_SAMPLE_MAX_CHARS = 4096;

interface QuantifierInfo {
  length: number;
  isQuantifier: boolean;
  repeatsMoreThanOnce: boolean;
  unbounded: boolean;
  isBraceUnbounded: boolean;
  exceedsCap: boolean;
}

// Linear-time static guard against catastrophic exponential and polynomial ReDoS patterns:
// - Rejects backreferences (\1..\9 and \k<...>) outside character classes.
// - Rejects any quantifier (+, *, ?, {m,n}) or alternation (|) inside a repeated group.
// - Caps {m,n} bounds to <= 100 and rejects unbounded {m,} inside groups.
// - Caps total unbounded quantifiers (*, +, {m,}) across the entire pattern to <= 3.
function unsafeRegexReason(pattern: string): string | null {
  const groupStack: Array<{ hasQuantifierOrAlt: boolean }> = [];
  let inCharClass = false;
  let unboundedCount = 0;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      if (!inCharClass && i + 1 < pattern.length) {
        const next = pattern[i + 1]!;
        if (next >= '1' && next <= '9') {
          return '正则规则不允许使用反向引用，请简化表达式';
        }
        if (next === 'k' && pattern[i + 2] === '<') {
          return '正则规则不允许使用反向引用，请简化表达式';
        }
      }
      i += 2;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      i += 1;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      i += 1;
      continue;
    }
    if (ch === '(') {
      groupStack.push({ hasQuantifierOrAlt: false });
      if (pattern[i + 1] === '?') {
        const tag = pattern[i + 2];
        if (tag === ':' || tag === '=' || tag === '!') {
          i += 3;
          continue;
        }
        if (tag === '<') {
          const after = pattern[i + 3];
          if (after === '=' || after === '!') {
            i += 4;
            continue;
          }
          const closeIdx = pattern.indexOf('>', i + 3);
          if (closeIdx !== -1) {
            i = closeIdx + 1;
            continue;
          }
        }
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '|') {
      if (groupStack.length > 0) {
        groupStack[groupStack.length - 1]!.hasQuantifierOrAlt = true;
      }
      i += 1;
      continue;
    }
    if (ch === ')') {
      const frame = groupStack.pop();
      const quant = readQuantifier(pattern, i + 1);
      if (quant.isQuantifier) {
        if (quant.exceedsCap) {
          return `正则规则量词上限不能超过 ${IM_RULE_MAX_QUANTIFIER_BOUND}`;
        }
        if (quant.unbounded) {
          unboundedCount += 1;
          if (unboundedCount > IM_RULE_MAX_UNBOUNDED_QUANTIFIERS) {
            return '正则规则包含过多无界量词，请简化表达式';
          }
        }
        if (quant.isBraceUnbounded && groupStack.length > 0) {
          return '正则规则分组内不允许使用无上限量词，请简化表达式';
        }
        if (frame?.hasQuantifierOrAlt && quant.repeatsMoreThanOnce) {
          return '正则规则包含可能导致性能回溯的嵌套量词或重复分支，请简化表达式';
        }
        if (groupStack.length > 0) {
          groupStack[groupStack.length - 1]!.hasQuantifierOrAlt = true;
        }
        i += 1 + quant.length;
        continue;
      }
      if (frame?.hasQuantifierOrAlt && groupStack.length > 0) {
        groupStack[groupStack.length - 1]!.hasQuantifierOrAlt = true;
      }
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '*' || ch === '?' || ch === '{') {
      const quant = readQuantifier(pattern, i);
      if (quant.isQuantifier) {
        if (quant.exceedsCap) {
          return `正则规则量词上限不能超过 ${IM_RULE_MAX_QUANTIFIER_BOUND}`;
        }
        if (quant.unbounded) {
          unboundedCount += 1;
          if (unboundedCount > IM_RULE_MAX_UNBOUNDED_QUANTIFIERS) {
            return '正则规则包含过多无界量词，请简化表达式';
          }
        }
        if (quant.isBraceUnbounded && groupStack.length > 0) {
          return '正则规则分组内不允许使用无上限量词，请简化表达式';
        }
        if (groupStack.length > 0) {
          groupStack[groupStack.length - 1]!.hasQuantifierOrAlt = true;
        }
        i += quant.length;
        continue;
      }
    }
    i += 1;
  }
  return null;
}

function readQuantifier(pattern: string, start: number): QuantifierInfo {
  const ch = pattern[start];
  if (ch === '+' || ch === '*') {
    const lazy = pattern[start + 1] === '?' ? 1 : 0;
    return {
      length: 1 + lazy,
      isQuantifier: true,
      repeatsMoreThanOnce: true,
      unbounded: true,
      isBraceUnbounded: false,
      exceedsCap: false,
    };
  }
  if (ch === '?') {
    const lazy = pattern[start + 1] === '?' ? 1 : 0;
    return {
      length: 1 + lazy,
      isQuantifier: true,
      repeatsMoreThanOnce: false,
      unbounded: false,
      isBraceUnbounded: false,
      exceedsCap: false,
    };
  }
  if (ch === '{') {
    const match = /^\{(\d+)(?:,(\d*))?\}(\?)?/.exec(pattern.slice(start));
    if (!match) {
      return {
        length: 0,
        isQuantifier: false,
        repeatsMoreThanOnce: false,
        unbounded: false,
        isBraceUnbounded: false,
        exceedsCap: false,
      };
    }
    const min = Number(match[1]);
    const maxRaw = match[2];
    const unbounded = maxRaw === '';
    const max = maxRaw === undefined ? min : unbounded ? Infinity : Number(maxRaw);
    const exceedsCap = min > IM_RULE_MAX_QUANTIFIER_BOUND || (Number.isFinite(max) && max > IM_RULE_MAX_QUANTIFIER_BOUND);
    const repeatsMoreThanOnce = max > 1;
    return {
      length: match[0].length,
      isQuantifier: true,
      repeatsMoreThanOnce,
      unbounded,
      isBraceUnbounded: unbounded,
      exceedsCap,
    };
  }
  return {
    length: 0,
    isQuantifier: false,
    repeatsMoreThanOnce: false,
    unbounded: false,
    isBraceUnbounded: false,
    exceedsCap: false,
  };
}

export type ParsedRuleRegex =
  | { isRegex: false }
  | { isRegex: true; ok: true; regex: RegExp; pattern: string; flags: string }
  | { isRegex: true; ok: false; error: string };

export function parseRuleRegex(rule: string): ParsedRuleRegex {
  const trimmed = rule.trim();
  const match = REGEX_LITERAL_RE.exec(trimmed);
  if (!match) return { isRegex: false };
  const pattern = match[1]!;
  const flags = match[2]!;
  if (pattern.length === 0) {
    return { isRegex: true, ok: false, error: '正则规则不能为空' };
  }
  if (pattern.length > IM_RULE_REGEX_MAX_CHARS) {
    return { isRegex: true, ok: false, error: `正则规则长度不能超过 ${IM_RULE_REGEX_MAX_CHARS} 个字符` };
  }
  const seenFlags = new Set<string>();
  for (const flag of flags) {
    if (!ALLOWED_REGEX_FLAGS.has(flag)) {
      return { isRegex: true, ok: false, error: `正则标志只支持 i、m、u，不支持 ${flag}` };
    }
    if (seenFlags.has(flag)) {
      return { isRegex: true, ok: false, error: `正则标志不能重复：${flag}` };
    }
    seenFlags.add(flag);
  }
  const unsafeError = unsafeRegexReason(pattern);
  if (unsafeError !== null) {
    return { isRegex: true, ok: false, error: unsafeError };
  }
  try {
    const regex = new RegExp(pattern, flags);
    return { isRegex: true, ok: true, regex, pattern, flags };
  } catch {
    return { isRegex: true, ok: false, error: `正则规则语法无效：${trimmed}` };
  }
}

export function validateRuleKeywords(raw: unknown): ValidationResult<string[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: '关键词规则必须是字符串数组' };
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, error: '关键词规则的每一项都必须是文字' };
    }
    const trimmed = item.trim();
    if (trimmed === '') {
      return { ok: false, error: '关键词规则不能为空' };
    }
    if (trimmed.length > IM_RULE_KEYWORD_MAX_CHARS) {
      return { ok: false, error: `单条关键词规则最多 ${IM_RULE_KEYWORD_MAX_CHARS} 个字符` };
    }
    const parsed = parseRuleRegex(trimmed);
    if (parsed.isRegex && !parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  if (result.length > IM_RULE_KEYWORDS_MAX) {
    return { ok: false, error: `关键词规则最多设置 ${IM_RULE_KEYWORDS_MAX} 条` };
  }
  return { ok: true, value: result };
}

export function validateAllowedSenders(raw: unknown): ValidationResult<string[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: '允许发言人列表必须是字符串数组' };
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, error: '允许发言人的每一项都必须是账号文字' };
    }
    const trimmed = item.trim();
    if (trimmed === '') {
      return { ok: false, error: '允许发言人不能为空' };
    }
    if (trimmed.length > IM_SENDER_MAX_CHARS) {
      return { ok: false, error: `发言人账号最多 ${IM_SENDER_MAX_CHARS} 个字符` };
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  if (result.length > IM_ALLOWED_SENDERS_MAX) {
    return { ok: false, error: `允许发言人最多设置 ${IM_ALLOWED_SENDERS_MAX} 个` };
  }
  return { ok: true, value: result };
}

export function validateCooldownSeconds(raw: unknown): ValidationResult<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < IM_COOLDOWN_MIN || raw > IM_COOLDOWN_MAX) {
    return { ok: false, error: `触发冷却时间必须是 ${IM_COOLDOWN_MIN} 到 ${IM_COOLDOWN_MAX} 之间的整数（秒）` };
  }
  return { ok: true, value: raw };
}

export function validateInlineContextCount(raw: unknown): ValidationResult<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < IM_INLINE_CONTEXT_MIN || raw > IM_INLINE_CONTEXT_MAX) {
    return { ok: false, error: `附带群上下文条数必须是 ${IM_INLINE_CONTEXT_MIN} 到 ${IM_INLINE_CONTEXT_MAX} 之间的整数` };
  }
  return { ok: true, value: raw };
}

export type GroupFastPathReason = 'disabled' | 'sender_denied' | 'no_mention_or_rule' | 'cooldown' | 'mention' | 'rule';

export interface GroupFastPathDecision {
  pass: boolean;
  reason: GroupFastPathReason;
  matchedKeyword?: string;
}

export function evaluateGroupFastPath(
  binding: Pick<
    ImGroupBindingView,
    'enabled' | 'trigger_mode' | 'allow_all_senders' | 'allowed_senders' | 'rule_keywords' | 'cooldown_seconds' | 'last_triggered_at'
  >,
  msg: Pick<NormalizedImMessage, 'actor' | 'text' | 'mentionedBot'>,
  opts: { isWhitelisted: boolean; nowMs?: number },
): GroupFastPathDecision {
  if (!binding.enabled) {
    return { pass: false, reason: 'disabled' };
  }
  const senderAllowed = binding.allow_all_senders || opts.isWhitelisted || binding.allowed_senders.includes(msg.actor);
  if (!senderAllowed) {
    return { pass: false, reason: 'sender_denied' };
  }
  if (msg.mentionedBot) {
    return { pass: true, reason: 'mention' };
  }
  if (binding.trigger_mode === 'mention_or_rules' && binding.rule_keywords.length > 0) {
    const sample = (msg.text ?? '').slice(0, IM_FAST_PATH_SAMPLE_MAX_CHARS);
    const lowerText = sample.toLowerCase();
    const nowMs = opts.nowMs ?? Date.now();
    for (const rawRule of binding.rule_keywords) {
      const rule = rawRule.trim();
      if (!rule) continue;
      const parsed = parseRuleRegex(rule);
      let matched = false;
      if (parsed.isRegex) {
        if (parsed.ok) {
          try {
            matched = parsed.regex.test(sample);
          } catch {
            matched = false;
          }
        }
      } else {
        matched = lowerText.includes(rule.toLowerCase());
      }
      if (!matched) continue;
      const lastMs = binding.last_triggered_at ? Date.parse(binding.last_triggered_at) : NaN;
      if (binding.cooldown_seconds > 0 && Number.isFinite(lastMs) && nowMs - lastMs < binding.cooldown_seconds * 1000) {
        return { pass: false, reason: 'cooldown', matchedKeyword: rule };
      }
      return { pass: true, reason: 'rule', matchedKeyword: rule };
    }
  }
  return { pass: false, reason: 'no_mention_or_rule' };
}
