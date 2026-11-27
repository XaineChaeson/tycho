// The one place tunable behaviour is declared. Values live in the ledger's `tunables`
// setting and only what differs from a default is stored. Modules never read this file:
// main.ts hands each of them the getter it needs, called at the moment of use. The ledger
// is the one exception, for the policy it applies itself: it holds the values, and reads
// them through `inForce` in the transaction that applies them.
import { statSync } from 'node:fs';
import { TIERS, type TierId } from '../shared/tiers.ts';
import { DegradedError, InputError } from './errors.ts';
import type { Ctx, Ledger } from './ledger.ts';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_PORT = 65_535;
const MAX_TEXT_CHARS = 200;

interface Described {
  group: string;
  title: string;
  help: string;
  // The service reads it once, when it starts.
  restart?: boolean;
  // What an empty value stands for, for an item that can be left empty.
  empty?: string;
}

export type Definition = Described & (
  | { type: 'duration'; unit: 'seconds' | 'minutes' | 'hours'; default: number; min: number; max: number }
  | { type: 'integer'; default: number; min: number; max: number }
  | { type: 'clock'; default: string }
  | { type: 'directory'; default: string }
  | { type: 'boolean'; default: boolean }
  | { type: 'port'; default: number }
  | { type: 'choice'; default: string; choices: readonly string[] }
  // One line, kept without the blanks around it.
  | { type: 'text'; default: string }
  // Empty, or a file that exists when it is set.
  | { type: 'file'; default: string }
  // Empty, or the bare base of an address: no credentials, query or fragment.
  | { type: 'url'; default: string; schemes: readonly string[]; originOnly?: boolean }
  // Logins in an order, each once. Which ones exist is the data directory's rule.
  | { type: 'logins'; default: readonly string[] }
);

const RUNS = '执行';
const ACCOUNTS = '账号';
const MACHINES = '机器';
const ROUTER = '负责人';
const IM = '消息通道';
const NOTICES = '通知';
const LOGIN = '登录';
const SERVICE = '服务';
const RELEASE = '上线';
const GATEWAY = '门牌';
const BACKUP = '备份';
const RETENTION = '保留';
const KNOWLEDGE = '知识';
const TRIGGERS = '触发器';
const INBOUND = '入站来源';
// Both answer on the loopback, which is what login links made on this machine rely on.
export const LOOPBACK = '127.0.0.1';
export const WILDCARD = '0.0.0.0';

// Which login a tier looks for first, one setting per tier (docs/design/roles-and-tiers.md §11).
// Generated from the tiers, so a tier added there gets its order without another edit here.
export type DispatchOrderKey = `dispatch.order.${TierId}`;
export const dispatchOrderKey = (tier: TierId): DispatchOrderKey => `dispatch.order.${tier}`;
type DispatchOrderDefinition = Described & { type: 'logins'; default: readonly string[] };
const DISPATCH_ORDER = Object.fromEntries(TIERS.map((tier): [DispatchOrderKey, DispatchOrderDefinition] => [
  dispatchOrderKey(tier.id),
  {
    group: RUNS,
    title: `${tier.label}先找哪个登录`,
    type: 'logins',
    empty: '没排：按全部登录原来的先后（先账号，再机器自己的登录）',
    help: `派发${tier.label}的任务时先找谁。这是整个 tycho 一份的顺序，和项目无关：列出的登录按这里的先后先试，没列出的排在后面；留空就是全部登录原来的先后。额度用完、排满或机器连不上的会自己换下一个，这里只是偏好，不是钉死。`,
    default: [],
  },
])) as Record<DispatchOrderKey, DispatchOrderDefinition>;
export const DISPATCH_ORDER_KEYS: readonly DispatchOrderKey[] = TIERS.map((tier) => dispatchOrderKey(tier.id));

export const SETTINGS = {
  'ui.locale': {
    group: SERVICE, title: '系统语言', type: 'text',
    help: '控制台界面、登录页、负责人默认回复与任务说明语言（支持内置 zh-CN / en 及任意热插拔语言包 ID）。切换后立即生效。',
    default: 'zh-CN',
  },
  'router.cli': {
    group: ROUTER, title: '负责人 CLI 路径', type: 'file', empty: '自动找执行器 CLI：先 PATH，再桌面/用户安装目录',
    help: '负责人未绑定自定义路径时自动定位对应执行器（支持 Claude / Codex / Gemini）。留空时优先 PATH，再查找常见安装位置；填的路径不在了也一样回退并由自检提示。下次启动负责人时生效：改完点下面的“重启负责人”。',
    default: '',
  },
  'router.account': {
    group: ROUTER, title: '负责人的账号', type: 'text', empty: '不绑定：用这台电脑自己的登录和默认档位',
    help: '账号决定负责人用哪个执行器和登录。机器上的账号须在主机上。留空沿用主机的 Claude 登录和默认档位。下次启动负责人时生效：改完点下面的“重启负责人”。',
    default: '',
  },
  'router.tier': {
    group: ROUTER, title: '负责人的档位', type: 'text', empty: '不指定，用执行器自己的默认档位',
    help: '负责人用账号里的哪一档。只在绑定了账号时有意义；留空用执行器自己的默认档位。下次启动负责人时生效：改完点下面的“重启负责人”。',
    default: '',
  },
  'router.directReadyNotice': {
    group: ROUTER, title: '验证报告直接通知', type: 'boolean',
    help: '你明确要求验证做完只通知、由你验收时，Tycho 在确认没有后续工作后直接推送待验收通知。关闭后，此类结算恢复交给负责人。',
    default: true,
  },
  'models.refreshMs': {
    group: ACCOUNTS, title: '模型列表多久问一次', type: 'duration', unit: 'hours',
    help: '执行器报告账号能用哪些模型，服务隔多久去问一次。保存账号、换登录和点“测试连接”时也会各问一次。问不到就还用上次读到的，页面上写着上次读到的时刻。调小能早些发现厂商加了新模型，调大更少去打扰执行器。',
    default: 6 * HOUR_MS, min: MINUTE_MS, max: 7 * DAY_MS,
  },
  'accounts.loginTimeoutMs': {
    group: ACCOUNTS, title: '在控制台登录账号最多等多久', type: 'duration', unit: 'minutes',
    help: '在账号页点登录后，从准备到你贴回授权码、再到填完档位，一共最多等这么久；过了这次登录就作废，重新点一次即可。登录拿到令牌后，新账号再给这么久填档位。15 分钟是 tycho 的默认，不是厂商的规定。',
    default: 15 * MINUTE_MS, min: MINUTE_MS, max: 2 * HOUR_MS,
  },
  'accounts.loginCleanupMs': {
    group: ACCOUNTS, title: '登录结束后等登录程序退出多久', type: 'duration', unit: 'seconds',
    help: '一次登录结束（成功、失败、取消或超时）后，tycho 结束它起的登录程序，并最多等这么久确认它们都退出了。等不到就在页面上写“尚未确认结束”，服务日志里记着进程编号。',
    default: 10 * SECOND_MS, min: SECOND_MS, max: 2 * MINUTE_MS,
  },
  'accounts.loginSettleMs': {
    group: ACCOUNTS, title: '登录结果画面多久不动算印完', type: 'duration', unit: 'seconds',
    help: 'Claude 登录成功后把令牌印在屏幕上。令牌印在最后一行、后面再没有别的字时，tycho 要等屏幕这么久没有新输出，才认定令牌印完了，再存下来；避免长令牌分几块到达时只存了前半段。网络慢、令牌常被截断时调大。',
    default: 5 * SECOND_MS, min: SECOND_MS, max: MINUTE_MS,
  },
  'accounts.expiryRemindDays': {
    group: ACCOUNTS, title: '登录快到期前几天提醒', type: 'integer',
    help: '厂商只说 Claude 的长期登录令牌大约一年有效、不给确切日期，所以 tycho 按“令牌存进来的那天 + 一年”估算到期日。离估算的到期日还有这么多天时，自检里出一条提醒，并给你推一条“等你”；已经过了估算日期的会说“可能已经失效”。同一个令牌只推一次，换了令牌重新计。',
    default: 30, min: 1, max: 365,
  },
  'accounts.signInPollMs': {
    group: ACCOUNTS, title: '在机器上登录时，多久问一次进度', type: 'duration', unit: 'seconds',
    help: '在机器页点“登录”后，那台机器上的登录程序在跑的这段时间里，机器每隔这么久来问一次主机，把登录的进度（网址、用户码、成没成功）报上来。调小页面上更快看到用户码，调大机器和主机之间的请求少一些。登录结束后恢复平时的节奏。',
    default: SECOND_MS, min: SECOND_MS, max: 30 * SECOND_MS,
  },
  'node.pollHoldMs': {
    group: MACHINES, title: '机器等命令的挂起时长', type: 'duration', unit: 'seconds',
    help: '机器上的客户端问“有没有活要干”时，服务端最多把它挂住多久。文档里中间层（nginx、云负载均衡）的空闲超时是 60 秒，默认留了余量。改了之后，已经在挂着的那一次还是按旧值。调大响应更快、中间层更容易掐断，调小请求更频繁。',
    default: 25 * SECOND_MS, min: 5 * SECOND_MS, max: 5 * MINUTE_MS,
  },
  'node.commandTimeoutMs': {
    group: MACHINES, title: '机器多久没回答就算没答', type: 'duration', unit: 'seconds',
    help: '发给机器的一条命令（取快照、启动、问状态、读输出）最多等多久。超时不是“没执行”，而是“问不出来”：这一轮按判不出来的规则走，不会重发启动。调大容得下慢机器，调小更快发现机器出问题。',
    default: 2 * MINUTE_MS, min: 10 * SECOND_MS, max: 30 * MINUTE_MS,
  },
  'node.joinTtlMs': {
    group: MACHINES, title: '放行请求的有效期', type: 'duration', unit: 'minutes',
    help: '在那台机器上运行加入命令后，屏幕上那个六位数和它对应的请求多久内有效。过了这个时间要重新运行加入命令。放行之后，机器还要在这段时间内把令牌取走，否则要重新放行。',
    default: 15 * MINUTE_MS, min: MINUTE_MS, max: DAY_MS,
  },
  'node.endedJoinKeepMs': {
    group: MACHINES, title: '处理过的放行请求记多久', type: 'duration', unit: 'hours',
    help: '一条加入请求被放行、拒绝或过期之后，服务还记着它这么久。这段时间里在企业微信卡片上再点按钮，会如实说“已经处理过”或“已经过期”；记不得了就一律说已经过期。只记在内存里，重启就忘。',
    default: DAY_MS, min: HOUR_MS, max: 7 * DAY_MS,
  },
  'node.endedJoinMax': {
    group: MACHINES, title: '处理过的放行请求最多记几条', type: 'integer',
    help: '和上一项一起用：超过这么多条时，最早的先忘掉。',
    default: 200, min: 10, max: 10_000,
  },
  'node.materialTtlMs': {
    group: MACHINES, title: '接入材料的有效期', type: 'duration', unit: 'minutes',
    help: '任务派生机器时，服务在那一轮启动的时候发给执行者一份一次性接入材料，新机器凭它加入，不需要放行。材料从发出算起这么久内有效，过了就要让下一轮重新拿。实例从创建到起来接入要多久，就调到够用；调小更安全。改了之后，已经发出的材料按发出时的时长。',
    default: 15 * MINUTE_MS, min: MINUTE_MS, max: DAY_MS,
  },
  'node.inviteTtlMs': {
    group: MACHINES, title: '接入名额的有效期', type: 'duration', unit: 'hours',
    help: '负责人申请一条接入名额后，这么久内任务开始的轮次才会被发给材料；过了名额就作废，要重新申请。负责人申请时可以指定更短的。已经申请的名额按申请时的时长。',
    default: 2 * HOUR_MS, min: MINUTE_MS, max: 7 * DAY_MS,
  },
  'node.inviteMaxMachines': {
    group: MACHINES, title: '一条接入名额最多登记几台', type: 'integer',
    help: '负责人申请接入名额时，一条名额允许登记的机器数不能超过这个数；超过的申请被拒。调大让一个任务一次开更多实例，调小更稳妥。',
    default: 3, min: 1, max: 50,
  },
  'node.gapSlackMs': {
    group: MACHINES, title: '两次询问之间的在线宽限', type: 'duration', unit: 'seconds',
    help: '机器上的客户端每问完一次“有没有活要干”，马上会再问一次。上一次答完以后，下一次多久没来就当这台机器不在了，它上面的执行从那一刻起算失联。和“挂起时长”不是一回事：挂起时长是一次询问挂着没答的时间，这一项是两次询问之间的空档。网络慢、走代理、客户端和服务端隔得远时调大；调小则机器掉线发现得更快。',
    default: 10 * SECOND_MS, min: SECOND_MS, max: 5 * MINUTE_MS,
  },
  'node.outputStoreLimitMb': { group: MACHINES, title: '本机待传输出总预算（MiB）', type: 'integer', help: '只计算机器输出保留根与旧原始输出，不是整机磁盘或内存。下调后保留未处置结果，暂停新预留直到达标。', default: 1024, min: 64, max: 1048576 },
  'node.runOutputLimitMb': { group: MACHINES, title: '每轮原始输出保留量（MiB）', type: 'integer', help: '新轮次冻结的两路原始输出保留预算；超出时保留有界尾段和缺口，不停止执行者。', default: 32, min: 1, max: 1024 },
  'node.resultLimitMb': { group: MACHINES, title: '每轮原生结果上限（MiB）', type: 'integer', help: '新轮次冻结的解析状态与结果上限。超过时待核实，请核现场后改文件交付或调限，不自动重做。', default: 16, min: 1, max: 1024 },
  'node.executorRefreshMs': {
    group: MACHINES, title: '机器多久重看一次自己的执行器', type: 'duration', unit: 'minutes',
    help: '机器上的客户端隔这么久重新看一次本机装了哪些执行器、什么版本、登录了没有、能不能只读，看完随下一次询问报给服务。机器页上的“测试连接”随时能让它马上看一次。调小更早发现机器上的变化，调大更少打扰机器。客户端在下一次询问时拿到新值。',
    default: 10 * MINUTE_MS, min: MINUTE_MS, max: DAY_MS,
  },
  'node.modelListTimeoutMs': {
    group: MACHINES, title: '机器问模型列表的时限', type: 'duration', unit: 'seconds',
    help: '机器上的客户端问执行器“你能用哪些模型”时，这一条命令最多等多久。刚登录完的执行器要上网重新拉厂商的模型列表，比别的探针慢，所以单独给它更长的时限；其余探针（版本、登录、只读）仍是 6 秒。超时时机器页会写明是这一问超时，模型可以手填。客户端在下一次询问时拿到新值。',
    default: 30 * SECOND_MS, min: 5 * SECOND_MS, max: 5 * MINUTE_MS,
  },
  'node.quotaReadTimeoutMs': {
    group: MACHINES, title: '机器读自己登录额度的时限', type: 'duration', unit: 'seconds',
    help: '机器自己的登录，额度只能在它那台机器上问。这一条命令最多等多久：Claude Code 的 `/usage` 要先数一遍这台机器上自己的会话，实测 55 秒，所以默认给 120 秒，比别的探针长得多；Codex 的问法几秒就答。这一读放在后台，不挡执行器报告，超时只让这一次读数没读到，页面照实写原因。客户端在下一次询问时拿到新值。',
    default: 2 * MINUTE_MS, min: 10 * SECOND_MS, max: 10 * MINUTE_MS,
  },
  'node.releaseCheckMs': {
    group: MACHINES, title: '机器多久问一次主机该跑哪一版', type: 'duration', unit: 'minutes',
    help: '机器上的客户端隔这么久问一次主机：主机跑的是哪一版、有没有这个版本的发布包。发现自己不是那一版时，它会在机器空闲、没有正在跑的轮次和登录时把自己换成那一版，再重新连回来。除这个间隔之外，客户端在启动、被主机以版本不符拒绝、断线重连之后也会马上问一次。调小更快跟上主机的版本，调大少打扰机器。',
    default: 10 * MINUTE_MS, min: MINUTE_MS, max: DAY_MS,
  },
  'machine.cooldownMs': {
    group: MACHINES, title: '连不上的机器隔多久再试', type: 'duration', unit: 'seconds',
    help: '派活时一台机器没应答，这么久内不再把新的一轮派给它；它上面已结束的执行也按这个间隔再去清理。调小更快用上恢复的机器，调大少在连不上的机器上白等。',
    default: MINUTE_MS, min: 5 * SECOND_MS, max: HOUR_MS,
  },
  'machine.probeFreshMs': {
    group: MACHINES, title: '刚应答过的机器多久内不再探', type: 'duration', unit: 'seconds',
    help: '派活前要确认机器还在。一台机器这么久之内应答过，就直接用它，不再先探一次。调大派活更快，调小更不容易把活派给刚刚掉线的机器。',
    default: 30 * SECOND_MS, min: SECOND_MS, max: 10 * MINUTE_MS,
  },
  'machine.sweepMs': {
    group: MACHINES, title: '多久清理一次机器上已结束的执行', type: 'duration', unit: 'minutes',
    help: '服务隔这么久去每台应答着的机器上看一次，把账本里已经结束、机器上还留着的执行收掉（它重新连上时会马上清一次）。调小残留留得更短，调大少打扰机器。',
    default: 10 * MINUTE_MS, min: MINUTE_MS, max: DAY_MS,
  },
  'run.timeoutMs': {    group: RUNS, title: '单次执行时限', type: 'duration', unit: 'hours',    help: '一轮执行最多跑多久，到时会被中断。调大能容下长任务，调小能更快止损。只对之后新开的执行生效，在跑的那轮按开始时的时限。',
    default: 3 * HOUR_MS, min: MINUTE_MS, max: 7 * DAY_MS,
  },
  'run.modelIdleTimeoutMs': {
    group: RUNS, title: '等待模型无响应时限', type: 'duration', unit: 'minutes',
    help: '没有运行中的工具调用或子进程、纯等待模型/初始化时，连续这么久没有任何进展就判定卡死并中止；正在跑本地耗时脚本或回测时绝不会触发误杀。填 0 关闭。',
    default: 20 * MINUTE_MS, min: 0, max: 6 * HOUR_MS,
  },
  'run.lostGraceMs': {
    group: RUNS, title: '机器失联宽限期', type: 'duration', unit: 'minutes',
    help: '连不上执行机器多久后，判定上面的执行已经不在并接续。调大更不容易误判，调小任务恢复得更快。',
    default: 10 * MINUTE_MS, min: MINUTE_MS, max: DAY_MS,
  },
  'run.maxLostContinuations': {
    group: RUNS, title: '丢失后自动接续的上限', type: 'integer',
    help: '同一任务连续这么多轮都丢失，就不再自动接续，停下来等你看；你点“继续”后从零重新计。没有机器接下、根本没启动的轮次不算。调大更省心，调小更早发现机器的问题。',
    default: 3, min: 1, max: 20,
  },
  'quota.restMs': {
    group: RUNS, title: '额度用完后歇多久', type: 'duration', unit: 'minutes',
    help: '一轮执行因为额度用完而结束后，它的账号歇这么久再放一轮进去试；执行器自己说了什么时候恢复，就按它说的。歇着期间，没指定账号的任务换到项目里别的账号上，指定了的留在队列里等。调小试得更勤，调大更少白跑。',
    default: 30 * MINUTE_MS, min: MINUTE_MS, max: 7 * DAY_MS,
  },
  'quota.maxRestMs': {
    group: RUNS, title: '额度用完后最多歇多久', type: 'duration', unit: 'hours',
    help: '歇完放进去的那一轮又立刻额度用完，就再歇，每次加倍，到这个时长为止；成功跑完一轮后从头算。',
    default: 6 * HOUR_MS, min: MINUTE_MS, max: 7 * DAY_MS,
  },
  'quota.warnPercent': {
    group: RUNS, title: '用量到百分之多少就靠后', type: 'integer',
    help: '执行器报告的用量到了这个百分比，它的账号就排到别的后面：只有别的都用不了时才派给它，免得一轮跑到一半额度用完。只对会报告用量的执行器有用。设成 100 等于只在用满时才靠后。',
    default: 100, min: 1, max: 100,
  },
  'quota.readStaleMs': {
    group: ACCOUNTS, title: '额度读数多旧就重新去问', type: 'duration', unit: 'minutes',
    help: '账号的剩余额度平时是 tycho 用这个账号时顺手记下的，账号闲着或在 tycho 以外用掉的就看不到。打开“用量”页时，读数比这个旧的账号会在主机上跑一次最小的请求去问一次，会用掉一点点额度，用掉的也记在用量里。填 0 就只在你点“刷新”时才问。',
    default: 10 * MINUTE_MS, min: 0, max: DAY_MS,
  },
  'quota.readTimeoutMs': {
    group: ACCOUNTS, title: '读一次额度最多等多久', type: 'duration', unit: 'seconds',
    help: '去问账号额度的那一次请求最多等这么久，过了就停下，页面上写“没有答复”，读数留着上一次的。',
    default: MINUTE_MS, min: 10 * SECOND_MS, max: 10 * MINUTE_MS,
  },
  'dispatch.frontLead': {
    group: RUNS, title: '靠前的账号可以多跑几轮', type: 'integer',
    help: '任务没指定账号时，按这个档位的派发顺序挑。靠前的那个可以比排在它后面的多跑这么多轮，再多就轮到后面的，不让它一个排长队。设成很大的数就是严格按顺序：前一个用不了才用后一个。',
    default: 100, min: 1, max: 1000,
  },
  ...DISPATCH_ORDER,
  'router.turnTimeoutMs': {
    group: ROUTER, title: '负责人单回合时限', type: 'duration', unit: 'minutes',
    help: '负责人处理一条消息最多多久，到时会被打断；从负责人进程就绪、拿到这条消息起算，它启动的时间不算在内。调大能容下慢回合，调小能更快腾出队列。从下一回合起生效，正在处理的那一回合按它开始时的时限。',
    default: 30 * MINUTE_MS, min: MINUTE_MS, max: 6 * HOUR_MS,
  },
  'router.startTimeoutMs': {
    group: ROUTER, title: '负责人启动最多等多久', type: 'duration', unit: 'seconds',
    help: '拉起负责人进程之后，等它报告准备好最多这么久；超时就结束这个进程，手上这条消息标为待核实，不自动重投（下一条消息来时再起）。执行器启动慢时调大。下一次拉起时生效。',
    default: 20 * SECOND_MS, min: 5 * SECOND_MS, max: 5 * MINUTE_MS,
  },
  'router.interruptGraceMs': {
    group: ROUTER, title: '打断后等负责人收尾多久', type: 'duration', unit: 'seconds',
    help: '打断负责人的一个回合（你点“打断”或回合超时）之后，等它自己收尾最多这么久；还没结束就结束它的整个进程。调大给它更多时间收好，调小更快腾出来。下一次打断时生效。',
    default: 15 * SECOND_MS, min: SECOND_MS, max: 5 * MINUTE_MS,
  },
  'router.idleMs': {
    group: ROUTER, title: '项目负责人空闲多久退出', type: 'duration', unit: 'minutes',
    help: '每个项目的负责人进程没有消息要处理超过这么久就退出，下一条消息来了再接着这一段对话起来。调小省内存，调大少些重新起进程的等待。从下一回合结束起生效。',
    default: 30 * MINUTE_MS, min: MINUTE_MS, max: 24 * HOUR_MS,
  },
  'router.contextTokens': {
    group: ROUTER, title: '负责人上下文多长就换新的', type: 'integer',
    help: '项目负责人的对话上下文涨到这么多 token，就在下一条消息之前换一个新的上下文：从账本重建（没结束的任务、待答的问题、主人还没闭合的要求都在），主人看到的还是同一段对话。这样不靠执行器自己压缩，也不用主人说“新话题”。填 0 就不按长度换。从下一条消息起生效。',
    default: 0, min: 0, max: 1_000_000,
  },
  'router.materialKb': {
    group: ROUTER, title: '负责人恢复材料最多多大', type: 'integer',
    help: '项目负责人换了新的上下文时，先给它一份从账本重建的材料（常驻的工作方法、没结束的任务、待答的问题、待核实的请求、主人还没闭合的要求）。整份材料最多这么多 KB；放不下的部分不丢，材料里写明用哪个工具接着读。从下一次换上下文起生效。',
    default: 64, min: 8, max: 1024,
  },
  'site.outputLimitKb': {
    group: RUNS, title: '现场每段工具输出最多保留多少', type: 'integer',
    help: '任务页现场中，每次工具调用的输出（以及输入、失败原因、改动）最多保留这么多 KB，超出只留开头和结尾，并写明省略了多少。截断后的内容保存在服务内存和主机诊断文件中；这项截断不修改机器上的原始日志。从下一行输出起生效，调大不会找回已经截去的正文。',
    default: 16, min: 1, max: 1024,
  },
  'site.diagnosticEvents': {
    group: RUNS, title: '每轮主机诊断最多保留多少条', type: 'integer',
    help: '每轮主机诊断只留最近这么多条事件，并同时受诊断容量上限限制，先达到哪项就按哪项裁掉更早的内容。现场明确标出省略了多少条；账本里的回执、摘要和状态不受影响。下一次查看现场或同步输出时生效，调大不会找回已经裁掉的事件。',
    default: 5000, min: 10, max: 25_000,
  },
  'site.diagnosticLimitKb': {
    group: RUNS, title: '每轮主机诊断容量上限', type: 'integer',
    help: '每轮主机诊断内容合计最多保留这么多 KiB，另带少量游标和缺口信息；同时受事件条数上限限制。放不下时裁掉更早的内容并标出缺口，不删除账本里的回执或摘要。下一次查看现场或同步输出时生效；固定的单行、单事件解析安全上限仍然适用。',
    default: 1024, min: 4, max: 8192,
  },
  'artifacts.fileLimitMb': {
    group: RUNS, title: '取回产物时单个文件的上限', type: 'integer',
    help: '一轮执行结束后，服务把执行者留下的非代码产物（发布包、报告这些；代码不回来，靠执行器自己推分支、开 PR，或者本来就在那个文件夹里）从机器上取回来。单个文件超过这么多 MB 就不取，任务页上会写明是哪个文件太大。取回时整个文件先放在内存里，调大要留够内存。下一次取回起生效。',
    default: 64, min: 1, max: 4096,
  },
  'artifacts.totalLimitMb': {
    group: RUNS, title: '一轮取回产物的总上限', type: 'integer',
    help: '一轮的产物加起来最多取回这么多 MB。按顺序取，哪个文件放进来会超过总量就跳过它、在任务页上写明，后面更小、还放得下的照取。比单个文件的上限还小时，它也就是单个文件的上限。下一次取回起生效。',
    default: 256, min: 1, max: 16_384,
  },
  'knowledge.briefLimitKb': {
    group: KNOWLEDGE, title: '每轮说明里的知识上限', type: 'integer',
    help: '派出的每一轮，说明（brief）里写进的知识正文和技能目录合计最多多少 KiB（按 UTF-8 字节算）。超了这一轮就不开，任务停住并说清是哪些条目超了，不会悄悄截掉一部分。调大能放下更多知识，调小让说明更短。下一次派发起生效。',
    default: 24, min: 1, max: 1024,
  },
  'knowledge.snapshotLimitKb': {
    group: KNOWLEDGE, title: '每轮快照里的知识与技能上限', type: 'integer',
    help: '派出的每一轮，快照里随附的知识和技能文件合计最多多少 KiB。超了这一轮就不开，任务停住并说清。下一次派发起生效。',
    default: 512, min: 1, max: 65_536,
  },
  'knowledge.entryLimitKb': {
    group: KNOWLEDGE, title: '单条正文上限', type: 'integer',
    help: '一条知识的正文最多多少 KiB。提交提议时超了就收不下；调小之后，已经发布的条目超了会让用到它的那一轮停住并说清。',
    default: 32, min: 1, max: 1024,
  },
  'knowledge.externalEntry': {
    group: KNOWLEDGE, title: '将全局常驻知识写给 Tycho 之外的会话', type: 'boolean',
    help: '开启后，机器把全局、常驻、不限职能的知识写进 Claude、Codex、dsh、Gemini（agy）的原生入口。关闭时只撤下本知识发布集合的入口；其他发布方、旧版归属不明的投影和自己的文件会保留，并报告占用。由 Tycho 派发的轮次照常从快照读取；没有隔离能力的机器可能无法承担固定知识版本的审阅。',
    default: false,
  },
  'knowledge.globalEntryLimitKb': {
    group: KNOWLEDGE, title: '执行器入口里的知识上限', type: 'integer',
    help: '机器上的 Claude、Codex、dsh、Gemini（agy）每次启动都会读一份全局指令；tycho 把全局、常驻、不限职能的知识写进那里（每台机器的客户端写，主机本机也写），这是那份文件正文的上限（KiB）。超了就不写、把旧的撤下，机器页写明超了多少，不会只写一部分。派出的每一轮不读这份文件（读不了的会在任务页上标出），它们的知识照常随说明送达。改完下一次写入口时生效。',
    default: 24, min: 1, max: 1024,
  },
  'knowledge.globalEntryCheckMs': {
    group: KNOWLEDGE, title: '主机多久核实一次本机的执行器入口', type: 'duration', unit: 'seconds',
    help: '主机隔这么久看一遍本机执行器的全局知识入口：新装的执行器补写，被挪走的写回来，旁边多了覆盖文件就如实改报告。内容没变时不重写文件。机器客户端在每次正常询问前核实入口，不看这一项，也不因此重新查询账号或模型。改完下一次核实起生效。',
    default: 60 * SECOND_MS, min: 1 * SECOND_MS, max: 60 * MINUTE_MS,
  },
  'knowledge.curateAtPercent': {
    group: KNOWLEDGE, title: '到上限的多少就整理', type: 'integer',
    help: '某个项目、某个职能每一轮实际带上的知识，到了上面两个上限的这么多百分比，服务就为进入它的那些条目建一个整理任务（已经有没结束的整理任务就并进去），赶在超限不开之前把重复的、放错作用域或加载方式的理一理。调低更早整理，调高更少打扰执行器。',
    default: 75, min: 1, max: 100,
  },
  'knowledge.logins': {
    group: KNOWLEDGE, title: '知识任务用哪些登录', type: 'logins', empty: '你所有的登录都能用',
    help: '知识的把关任务和整理任务只能用这里选出的登录（它们不属于任何项目，不看项目允许的登录）；留空表示你所有的登录都能用。这里只定能不能用，先找谁按任务那一档的全局派发顺序。写这份提议的执行器照常排除在外。下一次派发起生效。',
    default: [] as readonly string[],
  },
  'knowledge.evidenceLimitKb': {
    group: KNOWLEDGE, title: '单份提议的证据摘录上限', type: 'integer',
    help: '一份提议带的证据摘录合计最多多少 KiB。超了就收不下：只摘和结论相关的那几段，不要整份日志贴进来。',
    default: 256, min: 1, max: 16_384,
  },
  'wecom.botId': {
    group: IM, title: '机器人 Bot ID', type: 'text', empty: '不启用企业微信',
    help: '企业微信智能机器人的 Bot ID。填上就启用，清空就停用。启用前先填好 Secret 和接收人。改完马上按新值重连。',
    default: '',
  },
  'wecom.owner': {
    group: IM, title: '接收人', type: 'text', empty: '没有填',
    help: '通知发给谁、谁能在企业微信里指挥：你的企业微信账号（userid）。首次启用时它会被加进企微的白名单；以后改它，白名单里旧的那个会换成新的。',
    default: '',
  },
  'wecom.url': {
    group: IM, title: '网关地址', type: 'url', schemes: ['ws', 'wss'], empty: '官方网关',
    help: '企业微信长连接的地址。留空用官方网关，一般不用改。改完马上按新值重连。',
    default: '',
  },
  'im.wecom.chat': {
    group: IM, title: '企业微信 · 项目对话', type: 'boolean',
    help: '允许通过企业微信与项目负责人对话、下达任务和在群聊中触发。关闭后企业微信不再接管项目对话消息（已开启登录放行时仍可发“登录”）。',
    default: true,
  },
  'im.wecom.notify': {
    group: IM, title: '企业微信 · 主动通知', type: 'boolean',
    help: '允许将待验收、等你决定、失败提醒、每日简报和群播报等主动通知发往企业微信。',
    default: true,
  },
  'im.wecom.approveLogin': {
    group: IM, title: '企业微信 · 放行控制台登录', type: 'boolean',
    help: '允许在企业微信私聊中发送“登录”或“登录 <验证码>”来放行控制台登录。',
    default: true,
  },
  'im.weixin.chat': {
    group: IM, title: '微信 · 项目对话', type: 'boolean',
    help: '允许通过微信与项目负责人对话、下达任务和在群聊中触发。关闭后微信不再接管项目对话消息（已开启登录放行时仍可发“登录”）。',
    default: true,
  },
  'im.weixin.notify': {
    group: IM, title: '微信 · 主动通知', type: 'boolean',
    help: '允许将待验收、等你决定、失败提醒、每日简报和群播报等主动通知发往微信。默认关闭，避免在微信里产生过多打扰。',
    default: false,
  },
  'im.weixin.approveLogin': {
    group: IM, title: '微信 · 放行控制台登录', type: 'boolean',
    help: '允许在微信私聊中发送“登录”或“登录 <验证码>”来放行控制台登录。',
    default: true,
  },
  'outbox.giveUpAfterMs': {
    group: NOTICES, title: '通知发不出去时放弃的时限', type: 'duration', unit: 'hours',
    help: '一条通知从第一次发送失败起，重试多久后放弃。调大能熬过更长的断网，调小能让过时的通知早点作罢。正在重试的通知，下一次发送失败时按新值判断。',
    default: HOUR_MS, min: MINUTE_MS, max: 7 * DAY_MS,
  },
  'outbox.retryFirstMs': {
    group: NOTICES, title: '通知发送失败后第一次重试等多久', type: 'duration', unit: 'seconds',
    help: '一条通知发送失败后，隔这么久再发一次；之后每失败一次，间隔翻一倍，直到下一项的上限。调小重试得更勤，调大更少去敲一个连不上的通道。下一次发送失败时按新值算。',
    default: 2 * SECOND_MS, min: SECOND_MS, max: 10 * MINUTE_MS,
  },
  'outbox.retryMaxMs': {
    group: NOTICES, title: '通知重试的最长间隔', type: 'duration', unit: 'seconds',
    help: '通知重试的间隔一直翻倍，翻到这么长就不再变长。断网恢复后，最晚隔这么久通知就能发出去。比上一项还短时，按上一项。下一次发送失败时按新值算。',
    default: MINUTE_MS, min: SECOND_MS, max: HOUR_MS,
  },
  // What reaches the owner on WeCom without being asked (docs/design/project-sessions.md §2.1).
  'push.remindMs': {
    group: NOTICES, title: '等你处理的事多久再提醒一次', type: 'duration', unit: 'minutes',
    help: '待答的问题、停住要你处理的任务、失效的登录、等你点头的知识变更，推过一次你没处理，隔这么久再提醒一次。从上一次推送或提醒算起。处理掉了就不再提醒。',
    default: HOUR_MS, min: 5 * MINUTE_MS, max: 7 * DAY_MS,
  },
  'push.remindMax': {
    group: NOTICES, title: '同一件事最多再提醒几次', type: 'integer',
    help: '第一次推送之外，同一件事最多再提醒几次。填 0 就只推一次、不再提醒。',
    default: 3, min: 0, max: 20,
  },
  'push.resultWindowMs': {
    group: NOTICES, title: '同一项目的成果合并的时间窗', type: 'duration', unit: 'minutes',
    help: '一项工作完成等验收、已合入、已上线这类成果，第一条马上推；之后这么久之内同一项目的成果攒起来合成一条推。填 0 就每条各推各的。',
    default: 10 * MINUTE_MS, min: 0, max: DAY_MS,
  },
  'push.daily': {
    group: NOTICES, title: '每日简报', type: 'boolean',
    help: '每天在下一项的时刻推一条简报，按项目列等你的、完成的、在跑的、卡住的。只列有变化的项目，全都没变化就不发。',
    default: true,
  },
  'push.dailyAt': {
    group: NOTICES, title: '每日简报的时刻', type: 'clock',
    help: '本机时间，24 小时制。服务在这个时刻没在运行，下次启动后补发一次。',
    default: '09:00',
  },
  'triggers.graceMs': {
    group: TRIGGERS, title: '到点后多久内算准时', type: 'duration', unit: 'seconds',
    help: '定时触发器的时刻到了之后，服务在这段时间内受理就算准时；过了这段时间才受理（比如服务停着、电脑时钟往前跳了），就按触发器的“错过怎么办”处理。调大容得下更慢的扫描，调小更早把迟到当作错过。',
    default: 5 * MINUTE_MS, min: 10 * SECOND_MS, max: DAY_MS,
  },
  'triggers.minIntervalMs': {
    group: TRIGGERS, title: '定时触发器的最小间隔', type: 'duration', unit: 'minutes',
    help: '固定间隔和 cron 两次触发之间至少隔这么久，更密的规则建不了也改不成。每次触发都会唤醒一次项目负责人，调小会更费额度。只管之后新建和修改的规则。',
    default: 5 * MINUTE_MS, min: MINUTE_MS, max: DAY_MS,
  },
  'triggers.dedupeKeepMs': {
    group: TRIGGERS, title: '同一事件记多久', type: 'duration', unit: 'hours',
    help: '一次触发或入站事件受理之后，同一个触发器或来源的同一个事件编号在这么久内再来，按同一件事回答（内容一样回原来的凭证，不一样就拒收），不会再投一次。从第一次受理算起，重试不续期；过了这么久再来就算新的一次。',
    default: 7 * DAY_MS, min: HOUR_MS, max: 90 * DAY_MS,
  },
  'triggers.queueMax': {
    group: TRIGGERS, title: '每个项目最多排几条触发消息', type: 'integer',
    help: '一个项目里还没被负责人取走的触发消息（一次性的触发、入站来源投来的事件、内部事件）最多这么多条，满了新来的就拒收、计数（入站请求回 429，调用方可以稍后用同一个事件编号重试）。主人的消息和服务自己的通知不算在里面。周期性的触发器靠合并，每个最多排一条，也不算在里面。',
    default: 20, min: 1, max: 1000,
  },
  'triggers.perTriggerPerMinute': {
    group: TRIGGERS, title: '单个触发器或来源每分钟最多受理几次', type: 'integer',
    help: '同一个触发器或入站来源一分钟内受理的次数到了这个数，再来的就拒收、计数，不唤醒负责人。',
    default: 10, min: 1, max: 1000,
  },
  'triggers.perMinute': {
    group: TRIGGERS, title: '全部触发器和来源每分钟最多受理几次', type: 'integer',
    help: '所有触发器与入站来源加起来一分钟内受理的次数上限，防止一阵风暴把负责人和额度拖垮。',
    default: 60, min: 1, max: 10_000,
  },
  'triggers.dataLimitKb': {
    group: TRIGGERS, title: '一次触发或入站事件的数据上限', type: 'integer',
    help: '一次触发或入站事件带的数据（作为资料附在消息里）最多多大，单位 KiB；超过的拒收、计数。',
    default: 16, min: 1, max: 1024,
  },
  'triggers.inboundSkewMs': {
    group: INBOUND, title: '入站请求的签名时间允许差多少', type: 'duration', unit: 'seconds',
    help: 'tycho-v1 来源的请求里的签名时间和这台电脑的时钟最多差这么多，过旧或超前都拒收。GitHub 来源不签时间，只看事件编号去重。调大能容忍时钟不准的调用方，调小让截下来的旧请求更早作废。改完马上生效。',
    default: 5 * MINUTE_MS, min: 30 * SECOND_MS, max: HOUR_MS,
  },
  'triggers.inboundRotateMs': {
    group: INBOUND, title: '入站来源换密钥后旧密钥还能用多久', type: 'duration', unit: 'hours',
    help: '在控制台给入站来源换密钥后，旧密钥在这么久内仍然能验过签名，留给调用方换上新密钥；到点就作废，服务重启不会延长。填 0 就换了立即作废。只管之后的更换，已经在过渡的旧密钥按换的时候定下的时刻作废。',
    default: DAY_MS, min: 0, max: 30 * DAY_MS,
  },
  'triggers.problemAfter': {
    group: TRIGGERS, title: '同一种问题连续几次算出了问题', type: 'integer',
    help: '一个触发器或入站来源连续这么多次因为同一种原因收不下（签名验不过、项目里待处理的触发消息满了）或者规则算不出来，就算它出了问题，推一次“等你处理”，之后按提醒的设置合并提醒；中间有一次收下了就重新数。',
    default: 5, min: 1, max: 1000,
  },
  'triggers.problemAlertWindowMs': {
    group: TRIGGERS, title: '签名问题多久最多推一次', type: 'duration', unit: 'hours',
    help: '同一个入站来源“签名一直验不过”推给你之后，这么久之内再出同样的问题不再推，只在页面上显示，已推的那条按提醒的设置提醒。没有密钥的人也能制造这种失败，调大能挡住借此反复打扰你；中间正常收下的请求不会让它重新推。改完马上生效。',
    default: DAY_MS, min: 10 * MINUTE_MS, max: 7 * DAY_MS,
  },
  'login.linkTtlMs': {
    group: LOGIN, title: '登录链接有效期', type: 'duration', unit: 'minutes',
    help: '新发出的登录链接多久内能用。调大更方便，调小更安全。已发出的链接按发出时的有效期。',
    default: 10 * MINUTE_MS, min: MINUTE_MS, max: DAY_MS,
  },
  'login.sessionDays': {
    group: LOGIN, title: '登录保持天数', type: 'integer',
    help: '登录一次能保持多少天。调小后，超过新天数的已有登录立即失效。调大后，已有登录的浏览器仍按当初的天数清掉 Cookie。',
    default: 30, min: 1, max: 365,
  },
  'login.temporarySessionMs': {
    group: LOGIN, title: '临时放行保持多久', type: 'duration', unit: 'hours',
    help: '临时放行的新设备能保持多久。改后新放行的设备按新值，已经放行的设备到期时间不变；登录保持天数调小也会让超过新天数的设备立即退出。',
    default: 12 * HOUR_MS, min: HOUR_MS, max: 7 * DAY_MS,
  },
  'login.failWindowMs': {
    group: LOGIN, title: '登录失败按多长时间计数', type: 'duration', unit: 'seconds',
    help: '经门牌从外面来的登录：用错的登录链接、新设备申请，都按这段时间里有多少次来数。数满下面两项任何一个，就暂时不再回答，过了这段时间自动恢复；有效的登录链接永远能用，不受影响。改完马上生效。',
    default: MINUTE_MS, min: 10 * SECOND_MS, max: HOUR_MS,
  },
  'login.failsPerSource': {
    group: LOGIN, title: '同一个来源最多失败几次', type: 'integer',
    help: '上一项那段时间里，同一个来源最多这么多次，再多就暂时不回答它。调大对手滑更宽容，调小更难被人反复试。改完马上生效。',
    default: 10, min: 1, max: 1000,
  },
  'login.failsTotal': {
    group: LOGIN, title: '所有来源加起来最多失败几次', type: 'integer',
    help: '同一段时间里，所有来源加起来最多这么多次，再多就对谁都暂时不回答，防的是换着来源试。改完马上生效。',
    default: 60, min: 1, max: 10_000,
  },
  'release.healthWindowMs': {
    group: RELEASE, title: '上线后观察时长', type: 'duration', unit: 'seconds',
    help: '换上新版本后，盯着它看这么久：服务要一直用同一个进程回答，中途崩掉重启就算没通过。调到 0 就不观察。门牌、外部机器、没配的通道出问题不算没通过。',
    default: 10 * SECOND_MS, min: 0, max: 10 * MINUTE_MS,
  },
  'release.recoveryWaitMs': {
    group: RELEASE, title: '上线时等清点多久', type: 'duration', unit: 'seconds',
    help: '新版本起来后要把每台机器问一遍才开始接活。等这么久；机器慢、还没问完，也算这一版没问题，服务接着问完再接活。',
    default: 2 * MINUTE_MS, min: 0, max: 30 * MINUTE_MS,
  },
  'release.drainTimeoutMs': {
    group: RELEASE, title: '上线前等负责人多久', type: 'duration', unit: 'minutes',
    help: '上线要重启服务，服务会先等负责人手头这一回合做完再停。等这么久还不结束就照常停，剩下的留给重启后的清点。调到 0 就不等。',
    default: 5 * MINUTE_MS, min: 0, max: 30 * MINUTE_MS,
  },
  'http.port': {
    group: SERVICE, title: '端口', type: 'port', restart: true,
    help: '控制台和接口监听的端口。',
    default: 8787,
  },
  'http.host': {
    group: SERVICE, title: '监听地址', type: 'choice', choices: [LOOPBACK, WILDCARD], restart: true,
    help: '127.0.0.1 只有这台电脑自己能打开控制台；0.0.0.0 让局域网或组网里的手机、别的电脑也能打开。',
    default: LOOPBACK,
  },
  'http.reverseProxyPort': {
    group: SERVICE, title: '反向代理入口端口', type: 'integer', restart: true,
    help: '只在 127.0.0.1 开设对外入口，供本机 HTTPS 反代转发。填 0 关闭。请填好 HTTPS 对外地址，并让反代覆盖 X-Forwarded-For。改动后重启生效。',
    default: 0, min: 0, max: MAX_PORT,
  },
  'http.publicUrl': {
    group: SERVICE, title: '对外地址', type: 'url', schemes: ['http', 'https'], originOnly: true, empty: '只在这台电脑上用',
    help: '手机和别的电脑打开控制台用的地址，比如 http://10.0.0.5:8787；用门牌时填门牌的 https 地址。登录链接和通知里的链接都按它生成。只填到域名（和端口）为止，不带路径、用户名密码、? 和 #。改完马上生效。',
    default: '',
  },
  'gateway.ssh': {
    group: GATEWAY, title: '门牌机器', type: 'text', empty: '不启用门牌',
    help: '一台外面能访问到、你自己能控制的机器，写成 用户名@地址，SSH 端口不是 22 时写 用户名@地址:端口。填上就启用：这台电脑向它建立一条 SSH 连接并一直保持，它把外面来的请求转进来；清空就停用。启用前，运行服务的这个用户要能免密码 SSH 登录它，并把“对外地址”填成门牌的 https 地址。改完马上按新值重连。',
    default: '',
  },
  'gateway.wss': {
    group: GATEWAY, title: '门牌 443 WebSocket 通道', type: 'url', schemes: ['wss', 'ws'], empty: '关闭：直连 SSH 端口',
    help: '当本机网络或代理封锁 TCP 22 端口时，填门牌机器 nginx 443 上转发到本机 sshd 的 WebSocket 地址（如 wss://gw.example.com/_gateway），让 SSH 经 443 通道传输并完整保留 authorized_keys 密钥与端口限制。留空则直连门牌机器的 SSH 端口。改完马上按新值重连。',
    default: '',
  },
  'gateway.keyFile': {
    group: GATEWAY, title: '连门牌用的 SSH 私钥', type: 'file', empty: '用运行服务的这个用户自己的 SSH 配置和密钥',
    help: '连门牌机器用哪个私钥文件。留空就用运行服务的这个用户自己的 SSH 配置和密钥。改完马上按新值重连。',
    default: '',
  },
  'gateway.remotePort': {
    group: GATEWAY, title: '门牌机器上的端口', type: 'port',
    help: '门牌机器上接收转发的端口，只绑在它自己的 127.0.0.1 上。门牌上的反向代理把请求转到这个端口。改完马上按新值重连。',
    default: 18787,
  },
  'gateway.localPort': {
    group: GATEWAY, title: '对外入口的端口', type: 'port',
    help: '这台电脑上专门接门牌转来的请求的端口，只绑 127.0.0.1，门牌启用时才监听。它只提供页面和需要登录的接口，只该本机用的接口在这个端口上不存在。改完马上生效。',
    default: 8788,
  },
  'backup.dir': {
    group: BACKUP, title: '备份目录', type: 'directory', empty: '不自动备份',
    help: '每日备份放到哪个目录，最好在另一块盘上。留空表示不自动备份。',
    default: '',
  },
  'backup.at': {
    group: BACKUP, title: '每天备份的时刻', type: 'clock',
    help: '本机时间，24 小时制。选一个不忙的时候。',
    default: '03:30',
  },
  'backup.keepDays': {
    group: BACKUP, title: '备份保留天数', type: 'integer',
    help: '超过这么多天的备份会被删掉，最新的一份总是留着。调大更占盘。下一次备份时按新值清理。',
    default: 14, min: 1, max: 3650,
  },
  'retention.endedDays': {
    group: RETENTION, title: '工作结束多少天后清理', type: 'integer',
    help: '机器代码副本和主机已登记产物按工作结束时间清理，主机 Worker 诊断正文按该轮结束时间清理。到期后不能再补读诊断正文；账本中的任务、回执、摘要和状态记录保留。下一次保留期清理时采用新天数。',
    default: 7, min: 1, max: 3650,
  },
} as const satisfies Record<string, Definition>;

export type SettingKey = keyof typeof SETTINGS;
// Key by key, so that a key not known until it runs takes the union of what the items hold.
export type SettingValue<K extends SettingKey> = K extends unknown
  ? (typeof SETTINGS)[K]['default'] extends number
    ? number
    : (typeof SETTINGS)[K]['default'] extends string
      ? string
      : (typeof SETTINGS)[K]['default'] extends readonly string[]
        ? readonly string[]
        : boolean
  : never;

// Where a name from outside becomes a key. Past this point a key is one by its type.
export function settingKey(name: string): SettingKey {
  if (!Object.hasOwn(SETTINGS, name)) throw new InputError(`没有这个配置项：${name}`);
  return name as SettingKey;
}

type SettingScalar = number | string | boolean | readonly string[];

interface SettingEntry {
  key: SettingKey;
  group: string;
  title: string;
  help: string;
  type: Definition['type'];
  unit?: 'seconds' | 'minutes' | 'hours';
  default: SettingScalar;
  min?: number;
  max?: number;
  choices?: readonly string[];
  schemes?: readonly string[];
  empty?: string;
  restart: boolean;
  value: SettingScalar;
  // The ledger holds a value for this key, whether or not this version accepts it.
  stored: boolean;
  // That value is the one in force.
  overridden: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

function span(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} 天`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} 小时`;
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS} 分钟`;
  if (ms % SECOND_MS === 0) return `${ms / SECOND_MS} 秒`;
  return `${ms} 毫秒`;
}

function outOfRange(value: number, { min, max }: { min: number; max: number }, shown: (bound: number) => string): string | null {
  if (value < min) return `不能小于 ${shown(min)}`;
  if (value > max) return `不能大于 ${shown(max)}`;
  return null;
}

// Null when an item of this kind can hold the value. Says nothing about the disk: a
// stored directory or file stays the setting while its drive is away.
export function problem(definition: Definition, value: unknown): string | null {
  switch (definition.type) {
    case 'duration':
      if (!Number.isInteger(value)) return '应为数字';
      return outOfRange(value as number, definition, span);
    case 'integer':
      if (!Number.isInteger(value)) return '应为整数';
      return outOfRange(value as number, definition, String);
    case 'clock':
      return typeof value === 'string' && CLOCK_TIME.test(value) ? null : '应为 24 小时制的 HH:MM，比如 03:30';
    case 'directory':
      return typeof value === 'string' ? null : '应为目录路径';
    case 'file':
      return typeof value === 'string' ? null : '应为文件路径';
    case 'boolean':
      return typeof value === 'boolean' ? null : '应为开或关';
    case 'port':
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PORT ? null : `应为 1 到 ${MAX_PORT} 的整数`;
    case 'choice':
      return definition.choices.includes(value as string) ? null : `只能是 ${definition.choices.join(' 或 ')}`;
    case 'text':
      if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return '应为一行文字';
      return value.length <= MAX_TEXT_CHARS ? null : `不能超过 ${MAX_TEXT_CHARS} 个字`;
    case 'url':
      return typeof value === 'string' ? addressProblem(value, definition.schemes, definition.originOnly) : '应为地址';
    case 'logins':
      if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id !== '')) return '应为登录的列表';
      return new Set(value).size === value.length ? null : '同一个登录重复了';
  }
}

// An address is shown on the pages as it stands and links are built on it. The parts
// that could carry a secret mean nothing in a base, so they are refused; and a value
// refused here is never quoted back, since it may be carrying one.
function addressProblem(value: string, schemes: readonly string[], originOnly = false): string | null {
  if (value === '') return null;
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (!url || !schemes.includes(url.protocol.slice(0, -1))) return `应为 ${schemes.join(' 或 ')} 地址`;
  if (originOnly && !/^[a-z][a-z\d+.-]*:\/\/[^\\/?#]+\/?$/i.test(value)) return '只写基础地址，只填到域名（和端口）为止';
  if (url.username || url.password || /[?#]/.test(value)) return '只写基础地址，不能带用户名密码、查询串（?）或片段（#）';
  return null;
}

// What is stored for a value that passed: the same thing however it was typed.
function normalized(definition: Definition, value: unknown): unknown {
  if (definition.type === 'text') return (value as string).trim();
  if (definition.type === 'url') return (value as string).trim().replace(/\/+$/, '');
  return value;
}

function missingOnDisk(definition: Definition, value: unknown): string | null {
  if ((definition.type !== 'directory' && definition.type !== 'file') || value === '') return null;
  const [word, fits] = definition.type === 'directory' ? ['目录', 'isDirectory'] as const : ['文件', 'isFile'] as const;
  const found = statSync(value as string, { throwIfNoEntry: false });
  if (!found) return `${word}不存在：${String(value)}`;
  return found[fits]() ? null : `不是${word}：${String(value)}`;
}

// A value this version would not accept, left by another version, is not in force.
function overrides(tunables: Record<string, unknown>, key: SettingKey): boolean {
  return Object.hasOwn(tunables, key) && problem(SETTINGS[key], tunables[key]) === null;
}

// What is in force for a key, given the ledger's stored overrides: the one rule, for the
// settings below and for the ledger reading its own policy inside a transaction.
export function inForce<K extends SettingKey>(tunables: Record<string, unknown>, key: K): SettingValue<K> {
  return (overrides(tunables, key) ? tunables[key] : SETTINGS[key].default) as SettingValue<K>;
}

function entries(): [SettingKey, Definition][] {
  return Object.entries(SETTINGS) as [SettingKey, Definition][];
}

export interface SettingsOptions {
  ledger: Pick<Ledger, 'getTunables' | 'writeTunable' | 'lastTunableChanges' | 'dispatchConditions' | 'transaction'>;
  // Rules that belong to an item's user, not to its kind: null, or why the value will not do.
  checks?: Partial<Record<SettingKey, (value: unknown) => string | null>>;
  // What else the ledger holds that follows from an item, written in the transaction
  // that changes the item. Listeners are for what cannot be: they run after the commit.
  derived?: Partial<Record<SettingKey, (change: { from: unknown; to: unknown }, ctx: Ctx) => void>>;
  log?: (line: string) => void;
}

export function createSettings({ ledger, checks = {}, derived = {}, log = (line) => console.error(line) }: SettingsOptions) {
  // In memory because reads have to outlive a retired ledger connection: login checks
  // run in degraded mode. Only this module writes the row, and only after it commits.
  let tunables = ledger.getTunables();
  const listeners = new Set<(key: SettingKey) => void>();

  const isStored = (key: SettingKey): boolean => Object.hasOwn(tunables, key);
  const isOverridden = (key: SettingKey): boolean => overrides(tunables, key);
  const current = (key: SettingKey): SettingScalar => inForce(tunables, key);

  function assertWritable(): void {
    const { degraded, recovering } = ledger.dispatchConditions();
    if (degraded) throw new DegradedError('账本写入失败，服务处于降级模式，现在不能改设置');
    if (recovering) throw new DegradedError('服务正在恢复清点，现在不能改设置');
  }

  // A rule judges the item at this value, however the value came about: typed in, or
  // the default being put back.
  function assertUsable(key: SettingKey, value: unknown): void {
    const unusable = checks[key]?.(value);
    if (unusable) throw new InputError(unusable);
  }

  function commit(key: SettingKey, to: unknown, override: boolean, ctx: Ctx): void {
    const from = current(key);
    tunables = ledger.transaction(() => {
      const written = ledger.writeTunable(key, { from, to, override }, ctx);
      if (to !== from) derived[key]?.({ from, to }, ctx);
      return written;
    });
    if (to === from) return;
    for (const listener of [...listeners]) {
      try {
        listener(key);
      } catch (err) {
        log(`设置 ${key} 已保存，但应用失败：${String(err)}`);
      }
    }
  }

  return {
    get<K extends SettingKey>(key: K): SettingValue<K> {
      return current(key) as SettingValue<K>;
    },

    // The type holds for this program's own calls. A value from outside only claims it,
    // so what is stored is still what passed the checks here.
    set<K extends SettingKey>(key: K, given: SettingValue<K>, ctx: Ctx): void {
      assertWritable();
      const definition: Definition = SETTINGS[key];
      const value = typeof given === 'string' && (definition.type === 'text' || definition.type === 'url') ? given.trim() : given;
      const refused = problem(definition, value) ?? missingOnDisk(definition, value);
      if (refused) throw new InputError(`${definition.title}${refused}`);
      const stored = normalized(definition, value);
      assertUsable(key, stored);
      if (stored !== current(key)) commit(key, stored, true, ctx);
    },

    // Clears whatever is stored, a value this version would not accept included, when
    // the item's rule accepts the default that leaves in force.
    reset(key: SettingKey, ctx: Ctx): void {
      assertWritable();
      if (!isStored(key)) return;
      assertUsable(key, SETTINGS[key].default);
      commit(key, SETTINGS[key].default, false, ctx);
    },

    list(): SettingEntry[] {
      const changes = new Map(ledger.lastTunableChanges().map((change) => [change.key, change]));
      return entries().map(([key, { group, title, help, type, restart = false, default: fallback, ...rest }]) => ({
        key, group, title, help, type, ...rest, default: fallback, restart,
        value: current(key),
        stored: isStored(key),
        overridden: isOverridden(key),
        updated_at: changes.get(key)?.at ?? null,
        updated_by: changes.get(key)?.actor ?? null,
      }));
    },

    subscribe(listener: (key: SettingKey) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Settings = ReturnType<typeof createSettings>;

export const backupConfig = (settings: Pick<Settings, 'get'>) => ({
  dir: settings.get('backup.dir'),
  at: settings.get('backup.at'),
  keepDays: settings.get('backup.keepDays'),
});
