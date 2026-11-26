// An inbound source's form and the lines its page shows (docs/design/triggers.md §2.2, §7). All
// pure: the page sends the whole definition and the service judges it.
import { GITHUB_HEADERS, STANDARD_WEBHOOK_HEADERS, TYCHO_V1_HEADERS, TYCHO_V1_VERSION, type InboundKind } from '@shared/triggers.ts';
import type { InboundSource } from './types.ts';

export interface InboundDraft {
  name: string;
  kind: InboundKind;
  projectIds: string[];
  note: string;
  pushFinal: boolean;
  resultReply: boolean;
  broadcastGroups: boolean;
  broadcastGroupIds: string[];
}

export const emptyInboundDraft = (kind: InboundKind): InboundDraft => ({
  name: '',
  kind,
  projectIds: [],
  note: '',
  pushFinal: false,
  resultReply: false,
  broadcastGroups: false,
  broadcastGroupIds: [],
});

export const inboundDraftOf = (source: InboundSource): InboundDraft => ({
  name: source.name,
  kind: source.kind,
  projectIds: [...source.project_ids],
  note: source.note,
  pushFinal: source.push_final,
  resultReply: source.result_reply ?? false,
  broadcastGroups: source.broadcast_groups ?? false,
  broadcastGroupIds: [...(source.broadcast_group_ids ?? [])],
});

export const inboundBody = (draft: InboundDraft): {
  name: string;
  kind: InboundKind;
  project_ids: string[];
  note: string;
  push_final: boolean;
  result_reply: boolean;
  broadcast_groups: boolean;
  broadcast_group_ids: string[];
} => ({
  name: draft.name.trim(),
  kind: draft.kind,
  project_ids: draft.kind === 'standard-webhooks' ? draft.projectIds.slice(0, 1) : draft.projectIds,
  note: draft.note.trim(),
  push_final: draft.pushFinal,
  result_reply: draft.kind === 'tycho-v1' && draft.resultReply,
  broadcast_groups: draft.broadcastGroups,
  broadcast_group_ids: draft.broadcastGroups ? draft.broadcastGroupIds : [],
});

// How a caller names the project it delivers to: tycho-v1 puts its number in the signed
// project header, while a GitHub event is routed by the repository the project names. The
// owner has to be able to read this here — a number that is nowhere on the page cannot be
// signed into a request.
export const projectLine = (project: { id: string; name: string; repos: string[] }, kind: InboundKind): string => {
  if (kind === 'tycho-v1' || kind === 'standard-webhooks') return `${project.name}（${project.id}）`;
  return project.repos.length === 0 ? `${project.name}（没配仓库）` : `${project.name}（${project.repos.join('、')}）`;
};

// Where a caller sends its requests: the public address when there is one, else only the path,
// which is reached on the service's own port inside the network.
export const inboundAddress = (path: string, publicUrl: string | null): string => (publicUrl ? `${publicUrl.replace(/\/$/, '')}${path}` : path);

// What a key is now: the one in force, or one replaced that still verifies until a moment.
export const keyLine = (key: { id: string; retires_at: string | null }): string =>
  key.retires_at === null ? `密钥 ${key.id}：在用` : `密钥 ${key.id}：已换下，过渡期到`;

// How a caller signs a tycho-v1 request (§2.2), said next to the key it was just given.
export const tychoSigningText = (): string =>
  `每次请求带三个头：${TYCHO_V1_HEADERS.event}（事件编号，同一事件重试时不变）、${TYCHO_V1_HEADERS.time}（签名时间，UTC 秒数）、${TYCHO_V1_HEADERS.signature}；`
  + `要投到哪个项目就带 ${TYCHO_V1_HEADERS.project}（项目编号，来源放行的项目列表里每个项目后面那串），它会被签进签名。`
  + `签名 = HMAC-SHA256(密钥, "${TYCHO_V1_VERSION}" + 换行 + 签名时间 + 换行 + 事件编号 + 换行 + 项目编号 + 换行 + 原始请求正文)，十六进制小写；不带项目头时项目编号一段是空串。`;

// What a GitHub caller fills in, said next to the key: the address goes in the repository's hook,
// and the key in its secret.
export const githubSigningText = (): string =>
  `在仓库的 Settings 里添一个推送地址，地址填上面这个，Content type 选 application/json，Secret 填这把密钥。`
  + `每条请求带 ${GITHUB_HEADERS.signature}（sha256= 加正文的 HMAC-SHA256）、${GITHUB_HEADERS.delivery}（事件编号）和 ${GITHUB_HEADERS.event}（事件种类）；`
  + `GitHub 不签时间，同一个事件编号在去重期内再来只算一次，过期后重放就挡不住了。`;

export const standardWebhooksSigningText = (): string =>
  `按 Standard Webhooks v1 规范接入：把上方地址与这把 whsec_ 密钥直接填入发送方（如集群任务报警通道或标准 SDK）。`
  + `每次请求需带 ${STANDARD_WEBHOOK_HEADERS.id}、${STANDARD_WEBHOOK_HEADERS.time}（UTC 秒）和 ${STANDARD_WEBHOOK_HEADERS.signature}（v1,<base64>，对 "<id>.<timestamp>.<raw_body>" 计算 HMAC-SHA256）。`
  + `因 Standard Webhooks v1 签名不含项目头，每个来源固定直达所放行的单个项目。`;
