// iLink owns transport and authentication. The shared front desk owns project placement.
// This private journal commits a poll batch with its cursor before accepting any next poll.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createWeixinApi, WeixinApiError, type WeixinAuth, type WeixinMessage } from '../channels/weixin-api.ts';
import type { ImChannelPermissions } from '../shared/im.ts';
import { deviceLoginDecisionText, deviceLoginMissingText, joinDecisionText, joinExpiredText, joinHandledText } from '../shared/labels.ts';
import type { Ledger } from './ledger.ts';
import type { JoinDecision } from './nodes.ts';
import { DeliveryUncertainError, type OutboxRow } from './outbox.ts';
import { DegradedError, InputError } from './errors.ts';
import { writeOwnerOnly } from './secrets.ts';

type Api = ReturnType<typeof createWeixinApi>;
type Menu = { ids: string[]; page: number; expires: number; messageId?: string };
type RejectedMessage = { key: string; at: string; reason: string; message: WeixinMessage };
interface Journal {
  version: 1;
  auth?: WeixinAuth;
  expired?: boolean;
  cursor: string;
  pending: WeixinMessage[];
  context: string;
  menu?: Menu;
  sends: Record<string, 'sending' | 'sent' | 'uncertain'>;
  seen: string[];
  controls: Record<string, string>;
  rejected: RejectedMessage[];
}
export interface WeixinStatus {
  state: 'disconnected' | 'waiting' | 'scanned' | 'pin_required' | 'connected' | 'expired' | 'error';
  qr?: string;
  bot_id?: string;
  user_id?: string;
  error?: string;
}
const empty = (): Journal => ({ version: 1, cursor: '', pending: [], context: '', sends: {}, seen: [], controls: {}, rejected: [] });
const PAGE = 8;
const REJECTED_LIMIT = 20;
const CONTROL = /^(?:固定当前项目|解绑|取消选择|上一页|下一页)$/;
const plain = (message: WeixinMessage): string | undefined => {
  if (message.message_type !== 1 || message.message_state !== 2 || !message.item_list?.length) return;
  // Mixed media is not silently reduced to a misleading partial request.
  if (message.item_list.some(item => item.type !== 1)) return;
  const parts = message.item_list.map(item => item.text_item?.text ?? '');
  return parts.some(Boolean) ? parts.join('\n') : undefined;
};

export function createWeixin(options: {
  file: string; ledger: Ledger; api?: Api; poll?: boolean;
  createLoginUrl?: () => string;
  loginValidity?: () => string;
  publicUrl?: () => string;
  approveDeviceLogin?: (code: string, actor: string, temporary: boolean) => { device: string; duration_ms?: number } | undefined;
  decideJoin?: (joinId: string, approve: boolean, actor: string) => JoinDecision;
  permissions?: () => ImChannelPermissions;
  onMessage(id: string): void; onChanged(): void; log?(line: string): void;
}) {
  const { ledger } = options;
  const api = options.api ?? createWeixinApi();
  const perms = (): ImChannelPermissions =>
    options.permissions?.() ?? { chat: true, notify: true, approve_login: true };
  let data = empty();
  let problem: string | undefined;
  let state: WeixinStatus['state'] = 'disconnected';
  let qr: { key: string; content: string; host?: string; pin?: string; until: number } | undefined;
  let controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let checking = false;
  let polling = false;
  let accepting = false;
  let broken = false;
  let generation = 0;
  if (existsSync(options.file)) {
    try {
      const value = JSON.parse(readFileSync(options.file, 'utf8')) as Journal;
      if (value.version !== 1 || !Array.isArray(value.pending) || typeof value.cursor !== 'string' || typeof value.context !== 'string' || !value.sends || typeof value.sends !== 'object' || Array.isArray(value.sends)
        || Object.values(value.sends).some(v => !['sent', 'sending', 'uncertain'].includes(v))
        || (value.auth && Object.values(value.auth).some(v => typeof v !== 'string' || !v))
        || (value.rejected !== undefined && !Array.isArray(value.rejected))) throw new Error('格式不完整');
      data = value;
      data.seen ??= []; data.controls ??= {}; data.rejected ??= [];
      for (const [key, value] of Object.entries(data.sends)) if (value === 'sending') data.sends[key] = 'uncertain';
      state = data.auth ? data.expired ? 'expired' : 'connected' : 'disconnected';
    } catch {
      broken = true; state = 'error'; problem = '微信本机恢复记录损坏，已停止收发。请保留文件并检查服务日志';
    }
  }
  function save(): void {
    if (broken) throw new InputError(problem!);
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    try { writeOwnerOnly(options.file, JSON.stringify(data)); }
    catch (error) { broken = true; state = 'error'; problem = '微信恢复记录未能写入，已停止收发'; throw error; }
  }
  function status(): WeixinStatus {
    return { state, ...(qr ? { qr: qr.content } : {}), ...(data.auth ? { bot_id: data.auth.botId, user_id: data.auth.userId } : {}), ...(problem ? { error: problem } : {}) };
  }
  const bot = () => `weixin:${data.auth!.botId}`;
  const target = () => `weixin:${data.auth!.botId}:${data.auth!.userId}`;
  const ownerTarget = () => data.auth ? { channel: 'weixin', target: { chatid: target(), chat_type: 1 as const } } : undefined;
  const changed = () => options.onChanged();
  function schedule(delay = 0): void {
    if (stopped || options.poll === false || broken) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, delay);
    timer.unref();
  }
  function enqueue(id: string, content: string): void {
    ledger.enqueueNotification('weixin', 'markdown', { external_id: id, target: { chatid: target(), chat_type: 1 }, content });
  }
  function menuText(): string {
    const menu = data.menu!;
    const available = new Map(ledger.frontProjects(bot(), target(), data.auth!.userId).map(project => [project.id, project.name]));
    const visible = menu.ids.slice(menu.page * PAGE, (menu.page + 1) * PAGE);
    const lines = visible.map((id, i) => `${i + 1}. ${available.get(id) ?? '项目已不可用（原序号保留）'}`);
    const current = ledger.frontCurrent(bot(), target(), data.auth!.userId);
    const changed = menu.ids.some(id => !available.has(id));
    return `${current && available.has(current) ? `当前项目：${available.get(current)}\n` : ''}选择项目（${menu.page + 1}/${Math.max(1, Math.ceil(menu.ids.length / PAGE))} 页）\n${lines.join('\n')}\n\n${changed ? '项目列表已变化，失效序号不会指向其他项目。说“我想换个项目”可重新打开最新列表。\n' : ''}${visible.length ? '回复本页序号选择。' : '先到控制台新建项目。'}${menu.ids.length > PAGE ? '可回复“上一页 / 下一页”。' : ''}\n选好后可回复“固定当前项目”，换绑先回复“解绑”。回复“取消选择”返回聊天。`;
  }
  function openMenu(messageId?: string): string {
    const all = ledger.frontProjects(bot(), target(), data.auth!.userId);
    const candidates = messageId ? JSON.parse(ledger.getMessage(messageId).candidates_json ?? '{}').projects as string[] | undefined : undefined;
    data.menu = { ids: all.filter(p => !candidates?.length || candidates.includes(p.id)).map(p => p.id), page: 0, expires: Date.now() + 15 * 60_000, ...(messageId ? { messageId } : {}) };
    return menuText();
  }
  function selectionApplied(selection: { projectId: string | null; fixed: boolean; messageId?: string }): boolean {
    const current = ledger.frontCurrent(bot(), target(), data.auth!.userId);
    const fixed = ledger.frontFixed(bot(), target());
    if (selection.projectId === null) return current === null && fixed === null;
    if (!ledger.frontProjects(bot(), target(), data.auth!.userId).some(project => project.id === selection.projectId)) return false;
    if (selection.fixed ? fixed !== selection.projectId : fixed !== null || current !== selection.projectId) return false;
    if (selection.messageId) {
      try { return ledger.getMessage(selection.messageId).project_id === selection.projectId; }
      catch (error) { if (error instanceof InputError) return false; throw error; }
    }
    return true;
  }
  async function receive(messages: WeixinMessage[], cursor: string): Promise<void> {
    if (accepting) throw new Error('微信收件正在入账');
    if (!data.auth || broken || stopped) return;
    accepting = true;
    try {
      data.pending.push(...messages);
      if (cursor) data.cursor = cursor;
      save();
      while (data.pending.length) {
        const message = data.pending[0]!;
        if (message.from_user_id === data.auth.userId && (!message.to_user_id || message.to_user_id === data.auth.botId) && (ledger.getWhitelist().weixin ?? []).includes(message.from_user_id)) {
          if (message.context_token) { data.context = message.context_token; save(); }
          const id = message.message_id;
          if (!(typeof id === 'string' && id.trim() || typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)) {
            const key = createHash('sha256').update(JSON.stringify(message)).digest('hex');
            if (!data.rejected.some(item => item.key === key)) {
              data.rejected.push({ key, at: new Date().toISOString(), reason: '微信消息没有稳定编号，不能作为任务或控制指令入账', message });
              data.rejected = data.rejected.slice(-REJECTED_LIMIT);
              save();
            }
            // This is only a diagnostic notice key. No executable external ID is made.
            enqueue(`weixin-rejected:${data.auth.botId}:${key}`, '有一条微信消息没有稳定编号，原始内容已保存在本机异常记录中，没有交给负责人执行。请重新发送这条要求的文字。');
            data.pending.shift(); save(); continue;
          }
          const externalId = `${data.auth.botId}:${message.from_user_id}:${String(id)}`;
          if (data.seen.includes(externalId)) { data.pending.shift(); save(); continue; }
          const text = plain(message);
          if (!text) enqueue(`weixin-unsupported:${externalId}`, '这版微信入口支持文字私聊。请把图片、语音或文件中的要求写成文字再发一次。');
          else {
            const trimmed = text.trim();
            const deviceCommand = /^登录\s*(\d{6})(?:\s*(临时))?$/.exec(trimmed);
            const joinCommand = options.decideJoin ? /^(放行|拒绝)\s*(\d{6})$/.exec(trimmed) : null;
            if (deviceCommand !== null) {
              if (!perms().approve_login) {
                enqueue(`weixin-login-disabled:${externalId}`, '微信通道当前未开启控制台放行权限，可在“设置 › 消息通道”开启。');
              } else {
                const code = deviceCommand[1]!;
                const temporary = deviceCommand[2] !== undefined;
                let content: string;
                try {
                  const result = options.approveDeviceLogin?.(code, message.from_user_id, temporary);
                  content = result ? deviceLoginDecisionText(true, result.device, result.duration_ms) : deviceLoginMissingText;
                } catch {
                  options.log?.('微信设备登录放行失败');
                  content = '暂时无法放行，请稍后重试';
                }
                enqueue(`weixin-device-login:${externalId}`, content);
              }
            } else if (trimmed === '登录') {
              if (!perms().approve_login) {
                enqueue(`weixin-login-disabled:${externalId}`, '微信通道当前未开启控制台放行权限，可在“设置 › 消息通道”开启。');
              } else if (!options.publicUrl?.()) {
                enqueue(`weixin-login-no-public:${externalId}`, '还没配置对外地址，先到“设置 › 门牌”配好再发“登录”');
              } else if (options.createLoginUrl) {
                try {
                  const link = options.createLoginUrl();
                  await sendDirectText(`点击登录控制台（${options.loginValidity?.() ?? '10 分钟'}内有效，仅限本人使用）：\n${link}`);
                } catch {
                  // Never log the underlying error here in case a transport error echoes the login link credential.
                  options.log?.('微信发送登录链接失败');
                }
              }
            } else if (joinCommand !== null) {
              if (!perms().approve_login) {
                enqueue(`weixin-join-disabled:${externalId}`, '微信通道当前未开启控制台放行权限，可在“设置 › 消息通道”开启。');
              } else {
                const approve = joinCommand[1] === '放行';
                const code = joinCommand[2]!;
                let content: string;
                try {
                  const decided = options.decideJoin!(code, approve, message.from_user_id);
                  if (decided.state === 'approved' || decided.state === 'rejected') {
                    content = joinDecisionText(approve, decided.join.name);
                  } else if (decided.state === 'handled') {
                    content = joinHandledText;
                  } else {
                    content = joinExpiredText;
                  }
                } catch (err) {
                  if (err instanceof InputError || err instanceof DegradedError) content = err.message;
                  else {
                    options.log?.(`微信放行机器失败：${String(err)}`);
                    content = '暂时无法记录，请稍后在控制台的“放行”里输入号码';
                  }
                }
                enqueue(`weixin-join:${externalId}`, content);
              }
            } else if (!perms().chat) {
              enqueue(`weixin-chat-disabled:${externalId}`, '微信通道当前未开启项目对话权限，可在“设置 › 消息通道”开启。');
            } else {
            const fields = { channel: 'weixin' as const, bot: bot(), externalId, actor: data.auth.userId, thread: target(), text, material: false };
            if (data.menu && data.menu.expires < Date.now()) { delete data.menu; save(); }
            const number = /^([1-8])$/.exec(text.trim());
            const selected = number && data.menu ? data.menu.ids[data.menu.page * PAGE + Number(number[1]) - 1] : undefined;
            const control = CONTROL.test(text.trim());
            let selection: { projectId: string | null; fixed: boolean; messageId?: string } | undefined;
            if (selected) selection = { projectId: selected, fixed: false, ...(data.menu?.messageId ? { messageId: data.menu.messageId } : {}) };
            else if (text.trim() === '解绑') selection = { projectId: null, fixed: false };
            else if (text.trim() === '固定当前项目') {
              const current = ledger.frontCurrent(bot(), target(), data.auth.userId);
              if (current) selection = { projectId: current, fixed: true };
            }
            // UI-only paging is kept in the journal; all placement and original words go
            // through the transactional front desk, including a selected waiting request.
            if ((control && !selection) || (number && data.menu && !selected)) {
              if (!data.controls[externalId]) {
                let content: string;
                if (number) content = '当前页没有这个序号，请按当前列表重新选择。说“我想换个项目”可重新打开列表。';
                else if (text.trim() === '取消选择') { delete data.menu; content = '已关闭项目选择。'; }
                else if (data.menu && /页$/.test(text.trim())) {
                  data.menu.page = Math.max(0, Math.min(Math.ceil(data.menu.ids.length / PAGE) - 1, data.menu.page + (text.trim() === '下一页' ? 1 : -1)));
                  content = menuText();
                } else content = text.trim() === '固定当前项目' ? '先选择一个项目。说“我想换个项目”即可打开列表。' : '当前没有打开项目列表。说“我想换个项目”即可打开。';
                data.controls[externalId] = content;
                save(); // The applied page and the exact reply survive as one write.
              }
              enqueue(`weixin-control:${externalId}`, data.controls[externalId]!);
            } else {
              const received = ledger.frontReceive({ ...fields, ...(selection ? { selection } : {}) });
              if (selection) {
                if (selectionApplied(selection)) { delete data.menu; save(); }
                else {
                  if (!data.controls[externalId]) {
                    data.controls[externalId] = '这次选择未生效，请按前台提示处理后重新选择；说“我想换个项目”可重新打开最新列表。';
                    save();
                  }
                  enqueue(`weixin-selection:${externalId}`, data.controls[externalId]!);
                }
              }
              if (received.projectMenu) {
                if (!data.controls[externalId]) { data.controls[externalId] = openMenu(); save(); }
                enqueue(`weixin-menu:${externalId}`, data.controls[externalId]!);
              }
              else if (received.state === 'received') { delete data.menu; save(); }
              if (received.fresh && received.state === 'received') options.onMessage(received.id);
              for (const id of received.released) options.onMessage(id);
            }
            }
          }
          data.seen.push(externalId);
          while (data.seen.length > 10_000) { const old = data.seen.shift()!; delete data.controls[old]; }
        }
        data.pending.shift(); save();
      }
    } finally { accepting = false; }
  }
  async function checkLogin(): Promise<void> {
    if (!qr || checking || stopped) return;
    checking = true;
    const active = qr;
    const secrets = [data.auth?.token, active.key, active.pin];
    try {
      if (Date.now() > active.until) { state = 'expired'; qr = undefined; problem = '二维码已过期，请重新扫码'; return; }
      const response = await api.qrStatus(active.key, { host: active.host, pin: active.pin, signal: controller.signal });
      secrets.push(response.bot_token);
      if (qr !== active || stopped) return;
      if (response.status.includes('need_verifycode')) { state = 'pin_required'; active.pin = undefined; }
      else if (response.status === 'scaned') { state = 'scanned'; active.pin = undefined; }
      else if (response.status === 'scaned_but_redirect' && response.redirect_host) active.host = response.redirect_host;
      else if (response.status === 'confirmed') {
        if (!response.bot_token || !response.ilink_bot_id || !response.ilink_user_id || !response.baseurl) throw new Error('微信未返回完整登录信息');
        const same = data.auth?.botId === response.ilink_bot_id && data.auth?.userId === response.ilink_user_id;
        if (!same && data.pending.length) throw new InputError('旧微信账号仍有未入账消息，请先恢复处理后再换账号');
        data = { ...(same ? data : { ...empty(), sends: data.sends, rejected: data.rejected }), expired: false, auth: { token: response.bot_token, botId: response.ilink_bot_id, userId: response.ilink_user_id, baseUrl: response.baseurl } };
        save();
        ledger.setWhitelist({ ...ledger.getWhitelist(), weixin: [data.auth!.userId] }, { actor: 'console' });
        state = 'connected'; qr = undefined; problem = undefined; changed();
      } else if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(response.status)) {
        state = 'expired'; qr = undefined; problem = response.status === 'binded_redirect' ? '微信提示已绑定其他连接，请在手机确认后重新扫码' : '二维码已过期或验证被限制，请重新扫码';
      }
    } catch (error) {
      if (qr === active && !stopped && !controller.signal.aborted && !broken) {
        const message = error instanceof WeixinApiError || error instanceof InputError ? error.message : '微信登录状态暂时无法读取，请检查网络';
        problem = secrets.filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length)
          .reduce((text, secret) => text.split(secret).join('[已隐去的凭据]'), message);
      }
    } finally { checking = false; }
  }
  async function tick(): Promise<void> {
    if (polling || stopped || broken) return;
    polling = true;
    const epoch = generation;
    let delay = 1000;
    try {
      if (qr) await checkLogin();
      else if (data.auth && !data.expired) {
        if (data.pending.length) await receive([], data.cursor);
        const epoch = data.auth;
        const response = await api.updates(epoch, data.cursor, controller.signal);
        if (epoch === data.auth && !data.expired && !stopped) {
          await receive(response.msgs, response.cursor);
          if (epoch === data.auth && !data.expired && !stopped) { state = 'connected'; problem = undefined; }
        }
      }
    } catch (error) {
      if (epoch === generation && !controller.signal.aborted) {
        if (error instanceof WeixinApiError && error.code === -14) { data.expired = true; save(); state = 'expired'; problem = '微信登录已失效，请在控制台重新扫码'; }
        else if (!broken) problem = '微信暂时连接不上，正在重连；已收消息保留在本机';
        delay = 5000;
      }
    } finally { polling = false; schedule(epoch === generation ? delay : 0); }
  }
  async function send(chatid: string, text: string, key: string): Promise<void> {
    if (!data.auth || data.expired || broken || qr || stopped) throw new InputError('微信没有可用登录，请在控制台扫码');
    if (chatid !== target()) throw new InputError('出站消息属于另一微信账号，已停止发送');
    if (!data.context) throw new InputError('微信尚无可回复的私聊上下文，请先给机器人发一条消息');
    const epoch = data.auth;
    const pieces = Array.from(text).reduce<string[]>((parts, char, i) => { const n = Math.floor(i / 3500); parts[n] = (parts[n] ?? '') + char; return parts; }, []);
    for (let i = 0; i < pieces.length; i++) {
      if (data.auth !== epoch || stopped) throw new Error('微信账号已切换');
      const id = createHash('sha256').update(`${epoch.botId}:${epoch.userId}:${key}:${i}`).digest('hex');
      if (data.sends[id] === 'sent') continue;
      if (data.sends[id]) throw new DeliveryUncertainError('微信外发结果未确认，请先在原聊天核对，不能自动重发');
      data.sends[id] = 'sending'; save();
      try {
        await api.send(epoch, epoch.userId, pieces[i]!, data.context, id, controller.signal);
        if (data.auth !== epoch) throw new Error('微信账号已切换');
        data.sends[id] = 'sent'; save();
      } catch (error) {
        if (data.auth !== epoch) throw new DeliveryUncertainError('微信账号已切换，旧账号外发结果未确认，请在原聊天核对');
        if (error instanceof WeixinApiError && !error.uncertain) {
          delete data.sends[id];
          if (error.code === -14) { data.expired = true; state = 'expired'; problem = '微信登录已失效，请在控制台重新扫码'; }
          else if (error.code === -2) { data.context = ''; }
          save(); throw error;
        }
        data.sends[id] = 'uncertain';
        try { save(); }
        catch { throw new DeliveryUncertainError('微信外发结果未确认，恢复记录也未能写入；请在原聊天核对，不能自动重发'); }
        throw new DeliveryUncertainError('微信外发结果未确认，请先在原聊天核对，不能自动重发');
      }
    }
  }
  async function sendDirectText(text: string): Promise<void> {
    if (!data.auth || data.expired || broken || qr || stopped) throw new InputError('微信没有可用登录，请在控制台扫码');
    if (!data.context) throw new InputError('微信尚无可回复的私聊上下文，请先给机器人发一条消息');
    const epoch = data.auth;
    const pieces = Array.from(text).reduce<string[]>((parts, char, i) => { const n = Math.floor(i / 3500); parts[n] = (parts[n] ?? '') + char; return parts; }, []);
    for (let i = 0; i < pieces.length; i++) {
      if (data.auth !== epoch || stopped) throw new Error('微信账号已切换');
      const clientId = randomBytes(16).toString('hex');
      await api.send(epoch, epoch.userId, pieces[i]!, data.context, clientId, controller.signal);
    }
  }
  return {
    status, receive, checkLogin, send, sendDirectText,
    ownerTarget: () => ownerTarget()?.target,
    noticeTargets: () => (!data.expired && data.context && ownerTarget() ? [ownerTarget()!] : []),
    async login(): Promise<WeixinStatus> {
      if (broken) throw new InputError(problem!);
      const epoch = ++generation;
      controller.abort(); controller = new AbortController(); stopped = false;
      qr = undefined; problem = undefined; state = 'waiting';
      let value: Awaited<ReturnType<Api['qr']>>;
      try { value = await api.qr(data.auth ? [data.auth.token] : [], controller.signal); }
      catch (error) { if (epoch === generation) { state = 'error'; problem = '无法获取微信二维码，请检查网络后重新扫码'; } throw error; }
      if (epoch !== generation) return status();
      qr = { key: value.qrcode, content: value.content, until: Date.now() + 8 * 60_000 };
      schedule(); return status();
    },
    pin(value: unknown): WeixinStatus {
      if (state !== 'pin_required' || !qr) throw new InputError('当前不需要输入手机验证码');
      if (typeof value !== 'string' || !/^\d{4,12}$/.test(value)) throw new InputError('请输入手机显示的验证码');
      qr.pin = value; schedule(); return status();
    },
    disconnect(): WeixinStatus {
      if (data.pending.length) throw new InputError('微信仍有未入账消息，请先恢复处理后再断开连接');
      generation++;
      controller.abort(); controller = new AbortController(); clearTimeout(timer); qr = undefined;
      data = { ...empty(), sends: data.sends, rejected: data.rejected }; save(); state = 'disconnected'; problem = undefined;
      ledger.setWhitelist({ ...ledger.getWhitelist(), weixin: [] }, { actor: 'console' }); changed(); return status();
    },
    start(): void { stopped = false; schedule(); },
    stop(): void { generation++; stopped = true; clearTimeout(timer); controller.abort(); },
    async sendOutgoing(row: OutboxRow, outgoing: { target: { chatid: string }; body: { msgtype: string; markdown?: { content: string }; template_card?: unknown } }): Promise<void> {
      const payload = JSON.parse(row.payload_json) as { target?: { chatid: string }; message_id?: string; force_resend_seq?: number };
      const chatid = payload.target?.chatid ?? outgoing.target.chatid;
      if (!data.auth || chatid !== target()) throw new InputError('出站消息属于另一微信账号，已停止发送');
      let text = outgoing.body.markdown?.content;
      if (row.kind === 'assign' && payload.message_id) {
        const key = `assign:${row.id}`;
        if (!data.controls[key]) { data.controls[key] = openMenu(payload.message_id); save(); }
        text = data.controls[key];
      }
      else if (!text) {
        const card = outgoing.body.template_card as { main_title?: { title?: string }; sub_title_text?: string; horizontal_content_list?: { keyname?: string; value?: string }[] } | undefined;
        text = [card?.main_title?.title, card?.sub_title_text, ...(card?.horizontal_content_list ?? []).map(p => `${p.keyname ?? ''} ${p.value ?? ''}`)].filter(Boolean).join('\n');
      }
      const sendKey = typeof payload.force_resend_seq === 'number' && Number.isInteger(payload.force_resend_seq) && payload.force_resend_seq > 0
        ? `${row.id}:resend:${payload.force_resend_seq}`
        : row.id;
      await send(chatid, text || '有一项更新，请到控制台查看。', sendKey);
    },
  };
}
export type Weixin = ReturnType<typeof createWeixin>;
