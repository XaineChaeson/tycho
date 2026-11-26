// How everything said on WeCom looks (docs/design/project-sessions.md §2): the project it is
// about, or 【系统】, first; the way to its page last — only the page address, never a token, or
// plainly that a phone cannot open the console when no address others can reach is set. The one
// place for it: the first send, a card replaced after a press and what goes around the Outbox all
// come through here.
import type { TemplateCard } from '../channels/wecom-cards.ts';
import { projectMark } from '../shared/labels.ts';
import type { Ledger } from './ledger.ts';

const MAX_MARKDOWN_BYTES = 20_000;
const TOO_LONG = '\n\n……内容太长，全文到 Console 看';
const TOO_LONG_PRIVATE = '\n\n……内容太长，已截断';
export const NO_ADDRESS = '控制台：还没有配置对外地址，手机上打不开';

type PresentLedger = Pick<Ledger, 'getProject' | 'getTask' | 'getProposal'>;

function fit(text: string, limit: number, suffix = TOO_LONG): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const room = Math.max(0, limit - Buffer.byteLength(suffix));
  return `${Buffer.from(text).subarray(0, room).toString().replace(/\uFFFD+$/, '')}${suffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactPublicUrl(body: string, origin: string): string {
  const withoutConsoleLink = body
    .replace(/\n\n\[在控制台打开\]\([^)\n]*\)/g, '')
    .replace(/\[在控制台打开\]\([^)\n]*\)/g, '');
  const normalized = origin.replace(/\/$/, '');
  if (!normalized) return withoutConsoleLink;
  const pattern = new RegExp(`${escapeRegExp(normalized)}(?:[^\\s)\\]>"']*)`, 'gi');
  return withoutConsoleLink.replace(pattern, '[私有控制台链接已隐藏]');
}

export function createPresenter({ ledger, publicUrl }: { ledger: PresentLedger; publicUrl?: () => string }) {
  const base = (): string => (publicUrl?.() ?? '').replace(/\/$/, '');
  // A page, never a token: the first visit on a phone signs in with the usual one-time link.
  const pageUrl = (path: string): string | undefined => (base() ? `${base()}/#${path}` : undefined);

  const quietly = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  const projectName = (projectId: string | null | undefined): string | null =>
    projectId ? quietly(() => ledger.getProject(projectId).name, null) : null;
  const markOf = (projectId: string | null | undefined): string => projectMark(projectName(projectId));

  return {
    pageUrl,
    projectName,
    redactForGroup: (text: string): string => redactPublicUrl(text, base()),

    taskProject: (taskId: string | null | undefined): string | null =>
      taskId ? quietly(() => ledger.getTask(taskId).project_id, null) : null,

    // The project a knowledge change is about: the one project all its entries are scoped to.
    proposalProject(id: string): string | null {
      return quietly(() => {
        const proposal = ledger.getProposal(id);
        const scopes = new Set((proposal.final ?? proposal.change).outputs.map(({ project_ids }) => (project_ids?.length === 1 ? project_ids[0]! : '')));
        const [only] = scopes;
        return scopes.size === 1 && only ? only : null;
      }, null);
    },

    // Markdown: cut in its body when too long, so the mark and the way to the page stay.
    // In group chats (`includeConsoleLink: false`), NEVER append or leak the owner's private
    // console URL — colleagues in the group must not receive the owner's private endpoint.
    text(projectId: string | null | undefined, body: string, path: string, options: { includeConsoleLink?: boolean } = {}): string {
      const includeLink = options.includeConsoleLink !== false;
      if (!includeLink) {
        const safeBody = redactPublicUrl(body, base());
        return fit(`${markOf(projectId)}${safeBody}`, MAX_MARKDOWN_BYTES, TOO_LONG_PRIVATE);
      }
      const url = pageUrl(path);
      const tail = `\n\n${url ? `[在控制台打开](${url})` : NO_ADDRESS}`;
      return `${fit(`${markOf(projectId)}${body}`, MAX_MARKDOWN_BYTES - Buffer.byteLength(tail))}${tail}`;
    },

    // A card opens its page when pressed anywhere but a button; without an address it says why not.
    card(projectId: string | null | undefined, template: TemplateCard, path: string, options: { includeConsoleLink?: boolean } = {}): TemplateCard {
      const includeLink = options.includeConsoleLink !== false;
      const marked = { ...template, main_title: { title: `${markOf(projectId)}${template.main_title.title}` } };
      if (!includeLink) {
        const { card_action: _ignored, ...withoutAction } = marked;
        return { ...withoutAction, sub_title_text: redactPublicUrl(marked.sub_title_text, base()) };
      }
      const url = pageUrl(path);
      return url
        ? { ...marked, card_action: { type: 1, url } }
        : { ...marked, sub_title_text: `${template.sub_title_text}\n${NO_ADDRESS}` };
    },
  };
}
