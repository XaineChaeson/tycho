// The words of triggers (docs/design/triggers.md), one copy for the service and the console.

// The channel a trigger's message comes in by: not the owner's words, and its reply stays in
// the console unless the trigger pushes it (§8).
export const TRIGGER_CHANNEL = 'trigger';
// Channels whose messages are the service's, not the owner's: an internal event, a trigger.
export const fromOwner = (channel: string): boolean => channel !== 'internal' && channel !== TRIGGER_CHANNEL;

// Where a project's trigger gets what it hands the Router: its own time rule, or an internal
// event (§2). An inbound source (§2.2) is tycho-wide, not a trigger source.
export const TRIGGER_SOURCES = ['schedule', 'event'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];
export const SOURCE_LABELS: Record<string, string> = { schedule: '定时', event: '内部事件' };

export const SCHEDULE_KINDS = ['once', 'every', 'cron'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export const SCHEDULE_LABELS: Record<ScheduleKind, string> = { once: '一次', every: '固定间隔', cron: 'cron' };

// What happens to moments the service was not there for (§5).
export const MISSED_POLICIES = ['latest', 'skip'] as const;
export type MissedPolicy = (typeof MISSED_POLICIES)[number];
export const MISSED_LABELS: Record<MissedPolicy, string> = { latest: '补最近一次', skip: '跳过' };

// What became of an accepted occurrence (§1): its own message, merged into a waiting one, a
// waiting one replaced by a newer revision, recorded only (missed, or past the deadline).
export type FireOutcome = 'delivered' | 'merged' | 'replaced' | 'missed' | 'expired';
export const OUTCOME_LABELS: Record<FireOutcome, string> = {
  delivered: '已投递',
  merged: '已合并进另一条',
  replaced: '被新修订替换',
  missed: '错过',
  expired: '过期',
};

// Why an occurrence was not accepted. None of them writes a record; each is counted (§1, §4).
export type RefusalReason =
  | 'disabled' | 'source' | 'conflict' | 'too_large' | 'rate_trigger' | 'rate_global' | 'queue_full'
  // The owner paused or archived the trigger's project (project-sessions §5): none of its
  // triggers runs.
  | 'project_paused' | 'project_archived'
  // An inbound source's own (§2.2): a header missing, a signature no live key made, a signing
  // time too far off, or no project of the source's list the event belongs to.
  | 'unsigned' | 'signature' | 'stale' | 'no_project';
export const REFUSAL_LABELS: Record<RefusalReason, string> = {
  disabled: '来源或触发器已停用或已删除',
  source: '来源和触发器的种类对不上',
  conflict: '同一个事件编号来了不同的内容',
  too_large: '事件数据超过大小上限',
  rate_trigger: '这个来源或触发器的接收速率到了上限',
  rate_global: '全部来源和触发器的接收速率到了上限',
  queue_full: '项目里待处理的触发消息满了',
  project_paused: '项目已暂停，到点的不投递',
  project_archived: '项目已归档，到点的不投递',
  unsigned: '请求缺事件编号、签名时间或签名，或者格式不对',
  signature: '签名不对：不是用这个来源现在有效的密钥签的',
  stale: '签名时间过旧或超前，超出允许的偏差',
  no_project: '没有对应项目：事件没指向这个来源放行的任何项目',
};

// The problems of a trigger or an inbound source itself that wait for the owner (§8), each a
// run of one kind of refusal or failure: signatures that keep failing, a project whose trigger
// queue stays full, a rule the service cannot work out any more.
export type TriggerProblem = 'signature' | 'queue_full' | 'broken';
export const PROBLEM_OF: Partial<Record<RefusalReason, TriggerProblem>> = { unsigned: 'signature', signature: 'signature', stale: 'signature', queue_full: 'queue_full' };
export const PROBLEM_LABELS: Record<TriggerProblem, string> = {
  signature: '入站来源一直验不过签名：看看调用方用的密钥和它的时钟',
  queue_full: '项目里待处理的触发消息一直是满的，新来的被拒收',
  broken: '规则失效了，服务算不出它什么时候触发',
};

// The inbound sources of the whole tycho (§2.2). A source is one caller, one address and one
// rotating key; a translator reads what that caller sends into events for the projects the
// owner let through. The kinds this program has, and what each one's requests look like.
export const INBOUND_KINDS = ['tycho-v1', 'standard-webhooks', 'github'] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];
export const INBOUND_KIND_LABELS: Record<InboundKind, string> = {
  'tycho-v1': 'tycho-v1（通用）',
  'standard-webhooks': 'Standard Webhooks (v1)',
  github: 'GitHub',
};
export const INBOUND_KIND_ABOUT: Record<InboundKind, string> = {
  'tycho-v1': '按 tycho 自己的协议签名投递：请求头里带事件编号、签名时间和签名，可选带项目编号（签进签名）。不写项目编号时，来源只放行一个项目就用它。',
  'standard-webhooks': '行业开放标准 Standard Webhooks v1（webhook-id / webhook-timestamp / webhook-signature: v1,<base64>，密钥格式 whsec_<base64>）。可直接对接集群任务报警或任何支持 Standard Webhooks 的外部系统；来源只放行一个项目时无需额外项目头。',
  github: '把一个 GitHub 仓库的推送指到这里：按正文的 repository.full_name 对上放行项目里填的仓库，对上几个就各投一次；签名不覆盖时间和事件编号，去重期内相同正文只投一次，期满后仍可重放。',
};

// The tycho protocol, version 1 (§2.2): what a caller sends and what it signs —
// HMAC-SHA256 with the key over "v1\n<signing time>\n<event id>\n<project id>\n" and the raw
// body's bytes, in lower-case hex; the signing time is UTC seconds. The project header is
// empty in what is signed when the request names no project.
export const TYCHO_V1_VERSION = 'v1';
export const TYCHO_V1_HEADERS = { event: 'X-Tycho-Event-Id', time: 'X-Tycho-Timestamp', signature: 'X-Tycho-Signature', project: 'X-Tycho-Project' } as const;
// Standard Webhooks v1 (https://www.standardwebhooks.com/): HMAC-SHA256 over
// "<webhook-id>.<webhook-timestamp>.<raw_body>" with base64-decoded key after "whsec_".
export const STANDARD_WEBHOOK_HEADERS = { id: 'webhook-id', time: 'webhook-timestamp', signature: 'webhook-signature' } as const;
// What a GitHub push sends (§2.2): its own headers, and its signature over the body alone.
export const GITHUB_HEADERS = { event: 'X-GitHub-Event', delivery: 'X-GitHub-Delivery', signature: 'X-Hub-Signature-256' } as const;
export interface InboundReceiptResult {
  fire_id: string;
  project_id: string;
  outcome: FireOutcome;
  state: string | null;
  reply?: string;
}

export const inboundResultPath = (sourceId: string, receiptId: string): string =>
  inboundPath(sourceId) + '/result/' + receiptId;
export const inboundPath = (sourceId: string): string => `/inbound/${sourceId}`;

// Whether the internet can reach the inbound sources (§2.2), by the gateway's state or an active
// reverse-proxy outside listener with a public address: without either they are only reached on
// the inside listener.
export type InboundReach = 'no_gateway' | 'gateway_down' | 'ready';
export const INBOUND_REACH_LABELS: Record<InboundReach, string> = {
  no_gateway: '没配置门牌，外部投不进来：只能从内网经服务的端口投递',
  gateway_down: '门牌连接故障：外部暂时投不进来',
  ready: '可以接收',
};
export const inboundReach = (
  gateway: 'off' | 'connecting' | 'connected' | 'down',
  options?: { reverseProxyPort?: number; publicUrl?: string | null },
): InboundReach => {
  if (gateway === 'connected') return 'ready';
  if ((options?.reverseProxyPort ?? 0) > 0 && Boolean(options?.publicUrl?.trim())) return 'ready';
  return gateway === 'off' ? 'no_gateway' : 'gateway_down';
};

// How the turn of an accepted occurrence went, as its message stands.
export const FIRE_MESSAGE_LABELS: Record<string, string> = {
  received: '排队中',
  processing: '负责人处理中',
  processed: '已处理',
  unverified: '未确认完成',
  ignored: '已作废',
};
