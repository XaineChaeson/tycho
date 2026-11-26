> 来源：2026-11-05 由调研子代理只读完成（读了各项目源码与文档），协调者未逐条复核。标了“文档转述”和“推断”的条目落笔前要再核对。真机实测见 [wecom-protocol.md](wecom-protocol.md)。

# 企业微信智能机器人长连接流式接入调研（附飞书对照）

**结论**：成熟实现都是"每个 req_id 同时只有一帧在途 + 只保留最新全文快照 + 约 0.8 s 节流"，按 6 分钟流寿命设计，过期后改主动推送或换 stream.id。"卡在第 14 帧"没有任何来源直接记载，最可能是客户端显示节奏问题，需要先看第 15 帧之后回执的 errcode 才能定性。

**证据等级**
- **读了源码**：GitHub 仓库与 unpkg 上的原文件，下表各列均属此类。
- **文档转述**：企业微信、腾讯云、飞书文档页经抓取工具摘要后返回，引号内是它给出的原句，落笔前建议自己核对一眼。
- **推断**：单独标注。

## 1. 各实现做法对比（企业微信长连接）

| 维度 | 官方 Node SDK 1.0.7 + 官方 OpenClaw 插件 [S1][S2] | sunnoy 社区插件 [S3] | Hermes Agent [S4] | LangBot [S5] | CowAgent [S6] | OpenAkita [S7] |
|---|---|---|---|---|---|---|
| 刷新节流 | SDK 无定时节流；同 req_id 串行，等回执再发下一帧，回执超时 5 s，队列上限 500。另有 `replyStreamNonBlocking`：上一帧未回执就跳过中间帧，finish 帧必发。插件按 OpenClaw 的 block 粒度逐块发，单帧超时 15 s | 可见文本和思考各 800 ms，窗口内只排一个尾随定时器发最新快照；等待提示 1 s 一跳 | 中间帧不节流（绕过全局 0.8 s / 24 字），只做内容去重；上一帧未回执则跳过 | 0.3 s 最小间隔，窗口内直接丢弃（无尾随），内容未变跳过；串行等回执 5 s | 0.1 s，发后不等回执 | 文本 0.8 s，思考/工具 2.0 s，等待计数 5 s 一帧；串行等回执 15 s |
| req_id / stream.id / 回执配对 | 回复透传回调 req_id；stream.id 一回合一个。回执按 req_id 配对，靠"同 req_id 只有一帧在途"区分，另用自增 seq 防超时回调与回执竞态。主动推送每次新 req_id | 同 SDK；轮转时换 stream.id，req_id 不变 | 每回合一个 stream_id，锁定创建时的 req_id；每 req_id 只记一个待回执帧 | msg_id 映射到 `req_id\|stream_id`；每 req_id 一个串行 worker | req_id 对一个 stream_id，不配对回执 | req_id 预建 stream_id；待回执表按 req_id |
| 首帧与工具展示 | 回复开始时发 `<think></think>`（finish=false）。工具过程不展示。无可见输出时用可见文字收尾，注释写明纯空白会被忽略、气泡一直转 | `<think>等待模型响应 Ns`，每秒更新；思考与正文合成一帧 | 同样的 `<think></think>` 种子帧；工具进度折进同一气泡 | 未见占位帧；跳过空白帧 | 无占位；工具调用前的文字用 `---` 分段累积在同一流 | `<think>等待模型响应 1s</think>`；`<think>` 内放思考摘要（600 字）和最近 8 条工具行，后接正文 |
| 时间窗 | 按 6 分钟处理：回执 846608 即标记过期，中间帧停发，最终文本改 `sendMessage`（markdown）；整回合处理超时 6 分钟 | 注释称 6 分钟是自创建起的绝对寿命，保活不延长。5 分钟轮转：finish 旧流，同 req_id 开新 stream.id；另有 4 分钟保活 | 流龄 ≥ 330 s 时不发 finish，改主动推送；846608/846604 同样回退；保活 120 s 可选，默认关 | 未找到 | 长连接模式未找到 | 保活 240 s，回合超时 300 s，文档写 6 分钟 |
| 长度 / Markdown / 卡片 | README：content 最长 20480 字节，支持 Markdown。SDK 有 `replyStreamWithCard`（msgtype `stream_with_template_card`）。插件把卡片单独发，再用文字收尾流；主动推送按 4000 字分块 | 4000 字分块 | 按 UTF-8 字节截到 20480；超 20 KB 被截断是未修 issue（#140043） | 自设 200000 字符上限，不按字节 | 未找到 | 20480 字节，自动截断 |
| 限流 | 未找到限流代码 | 未找到；issue #57 有用户看到"你问的太频繁了" | 每会话令牌桶 30/分（24 普通 + 6 控制），只对 finish 帧和独立消息计数，中间帧不计；错误码记为 846607 | 未找到 | 未找到 | 只告警；记的是 30 条/24 h、10 条/天，与官方文档数字不一致 |
| 断线重连 | 断开时拒绝全部在途和排队帧；退避 1 s 到 30 s，最多 10 次；收到 `disconnected_event` 不自动重连。插件无专门续流逻辑 | 最终回复失败进重试队列（TTL 5 分钟） | 846609 视为订阅丢失，清掉缓存的 req_id | 断开时清空全部流状态 | 未找到 | 文档自述：WS 回复失败回退 response_url |
| 群聊 / @ | 群策略白名单；同会话消息按 accountId:chatId 串行 | 未细读 | 去掉开头的 `@xxx`；群里靠缓存的入站 req_id 流式 | 未找到 | 群会话可共享 session | 长连接下收到的消息一律视为已 @ |
| "刷新太快 / 卡住"相关记录 | SDK issue #5：按 token 调用把队列堆满，日志里回执约 450 ms 一帧。Python SDK issue #10：后台已发完，客户端不渲染，过一会全部打出。插件 issue #194：一次到齐的全文，客户端仍逐字显示 | issue #171 标题称"客户端刷新/ack 语义不可靠"，等待秒数一直显示 1 s（无人回复） | 与上一帧内容相同的 finish 帧被静默丢弃，做法是末尾加零宽空格；6000 是版本冲突，当作已送达 | PR #2564 加节流的理由是全量快照重复上传，不是丢帧 | 注释"避免 WebSocket 拥塞" | 注释"避免触发未公开的单流频率/条数限制" |

**其他来源补充**
- **"85 帧上限"不是服务端限制**。sunnoy 注释写的是给 SDK 旧版每 req_id 队列上限 100 留余量；Hermes 和 OpenAkita 沿用了这个数。SDK 1.0.7 默认已是 500，自写客户端不需要它。
- **MateClaw [S8]**：进度刷新最小间隔 500 ms，上一次未完成则跳过，工具/审批事件立即刷。它实测流静默 60–120 s 后槽位被丢、最终 finish 被静默拒绝，因此 20 s 保活、180 s 强制 finish 并提示"结果稍后送达"。这与 sunnoy 的 4 分钟保活矛盾，未能验证哪个对。
- **AstrBot [S9]**：0.5 s 刷新间隔，首帧发可配置的占位文字。
- **Tencent WeKnora [S10]**：300 ms 批量刷新，发后不等回执。重连后不清流状态，下一帧在新连接上重发全文；finish 失败按 500 ms 重试 3 次。
- **multica [S11]**：主动推送超限的回执是 45009，并发超限是 45033，频率拦截时长等于限制窗口，所以不立即重试。
- **腾讯云 CodeBuddy 接入文档 [S12]（文档转述）**：首帧"正在处理，请稍候..."，"流式消息超时：6 分钟"，安全超时 5 分钟，超时回退 `aibot_send_msg`。
- **openclaw-china [S13]**：占位同为 `<think></think>`，上下文 TTL 6 分钟，finish 前留 2.5 s 宽限。
- **服务端原始报错**（sunnoy issue #107 日志）：`errcode=846608, errmsg=stream message update expired (>6 minutes), cannot update`。
- **官方文档 101463（文档转述）**：
  - "需在 10 分钟内完成所有刷新并设置 finish=true"；
  - "收到消息回调后，24 小时内可以往该会话回复消息"；
  - 30 条/分钟、1000 条/小时，未说明刷新帧是否计入；
  - "不支持流式消息+模板卡片的组合消息"、"目前暂不支持 msg_item 字段"，与 SDK 提供的方法矛盾，按文档处理更安全。
- **官方文档 101031（文档转述）**：流式 content"最长不超过20480个字节"，支持常见 Markdown，含 `<think></think>` 时客户端展示思考过程。
- **未找到 / 未读**：DataWorks 接入说明未找到；dify-on-wechat、Link-AI 未读；cc-connect 只发一帧 finish，无流式可比。

## 2. 飞书流式卡片对照

| 维度 | 官方文档（文档转述）[F1][F2] | OpenClaw 内置 feishu 扩展 [F3] | 飞书官方 OpenClaw 插件 [F4] |
|---|---|---|---|
| 更新接口 | `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content`，传全量文本；旧文本是新文本前缀时才有打字机效果，否则整段上屏 | 同接口；卡片 JSON 设 `streaming_mode: true`，`print_frequency_ms` 50，`print_step` 1 | 同接口；失败后降级 `im.message.patch` |
| sequence | 每张卡片所有操作共用，必须严格递增，否则 300317 | 每次请求前自增，并带 uuid 作幂等 | 同样逐次自增 |
| 频率 | 接口 1000 次/分、50 次/秒；流式模式下不受单卡 10 次/秒限制 | 160 ms 节流，新增 ≥ 18 字强制推；串行队列只保留最新文本 | CardKit 100 ms，patch 降级 1500 ms，工具状态 1500 ms；长间隔后先攒 300 ms；互斥发送，在途时有新内容则完成后立即补发；230020 限频时跳过该帧 |
| 收尾 | 流式模式开启 10 分钟后自动关闭，建议手动关；流式中的卡片不能转发，交互回调需先关流式 | 先补发最终文本，再更新卡片配置为 `streaming_mode: false` 并写摘要 | 同样先终稿再关流式 |

与企业微信的本质差别：飞书有 sequence 保序且文档明说流式模式不限 QPS，客户端打字机节奏可配；企业微信没有序号，回执只带 req_id，客户端节奏不可控。所以企业微信必须自己做单帧在途和节流。

## 3. 推荐做法（单用户，回合几秒到几十分钟，文本增量加工具调用）

1. **发送模型：单帧在途，只留最新快照。** 每个 req_id 同时最多一帧未回执；有新内容时只覆盖"待发快照"，回执到达后若快照有变化且已过最小间隔再发。来源：SDK `replyStreamNonBlocking`/`hasPendingAck`、飞书官方插件 flush-controller 的"在途则完成后补发"。不要像 LangBot 那样窗口内直接丢弃且无尾随，否则最后一段文字要等 finish 才出现。
2. **节流间隔：正文 1000 ms，工具/状态行 2000 ms，等待计时 5 s 一帧。** 依据：sunnoy 和 OpenAkita 都是 0.8 s / 2 s / 5 s 一档；SDK issue #5 日志显示回执本身约 450 ms，再快没有意义。取 1 s 而不是 0.8 s 是我的保守判断，因为你在约 250 ms 一档已经出过问题。
3. **回执处理：**
   - 超时取 15 s（官方插件 `REPLY_SEND_TIMEOUT_MS`；SDK issue #27 证明 5 s 在负载下会误判）。
   - 配对用"req_id + 本地自增序号"，过期的超时回调直接忽略（SDK `pendingAckSeq`）。
   - 中间帧失败或超时就丢弃；finish 帧必须等回执。
4. **首帧：收到消息立即发 `<think></think>`（finish=false）。** 来源：官方插件 `THINKING_MESSAGE`、文档 101031 的 think 标签说明。任何帧都不要只含空白。
5. **工具调用：折进同一气泡。** 内容结构为 `<think>` 内放"已运行时长 + 最近约 8 条工具行"，`</think>` 后接正文（OpenAkita `_compose_stream_display`、Hermes 工具进度）。每帧保证 think 标签闭合（OpenAkita 专门做了归一化）。
6. **时间窗：按 6 分钟绝对寿命设计，5 分钟轮转。**
   - 依据：服务端报错原文写 ">6 minutes"，官方插件和腾讯云文档也按 6 分钟；文档 101463 的 10 分钟不要依赖。
   - 做法：流龄到 5 分钟时用当前全文 finish 旧流，同一 req_id 开新 stream.id 续写（sunnoy `rotateStream`；你已实测一个 req_id 可承载多条流；req_id 文档称 24 小时内可回复）。
   - 回执 846608 或 846604 时，把该段全文用 `aibot_send_msg` markdown 发出（官方插件 `finishThinkingStream`）。
   - 长时间无输出时每 30–60 s 发一帧内容有变化的进度（计时即可），兼顾 MateClaw 观察到的静默掉槽。
7. **长度：单帧按 UTF-8 字节控制在约 18 KB。** 接近时在段落边界 finish 当前流、开新流续写；不要截断（Hermes #140043 的教训）。主动推送按 4000 字分块（官方插件 `TEXT_CHUNK_LIMIT`）。
8. **收尾帧：**
   - 必须含可见字符；
   - 与上一帧完全相同时末尾加零宽空格（Hermes）；
   - 回执 6000 视为已送达，不要另发一条造成重复；
   - finish 失败先在同一 stream.id 上重试（替换语义下幂等，WeKnora 500 ms 重试 3 次），只有过期类错误才改主动推送。
9. **限流：只对"新建一条消息"计数。** 新 stream.id、主动推送各算一条，按 30/分做令牌桶并留几个给收尾（Hermes 24 + 6）；中间刷新帧不计。遇到 846607 或 45009 不立即重试，等窗口过去（multica）。"中间帧不计入"是推断，依据见第 4 节。
10. **断线重连：保留流状态，重连后重发最新全文。** 保留 req_id、stream.id 和最新快照，重新订阅后在原 req_id/stream.id 上重发（WeKnora 的做法，与你"旧 req_id 在新连接可用"的实测一致）。断开时在途回执全部作废（SDK `clearPendingMessages`）。回执 846609 说明订阅丢失，需重新订阅。收到 `disconnected_event` 不要自动重连，否则两条连接互踢（SDK 与 Hermes 都有注释）。
11. **卡片和按钮：不放进流。** 单独发模板卡片，流用文字收尾（官方插件的做法；文档称组合消息不支持）。

## 4. "卡在第 14 帧"最可能的原因

没有任何来源记载"第 14 帧"这个现象，以下都是推断，按可能性排序。

1. **客户端显示节奏问题，不是服务端丢帧（最可能）。** 客户端有自己的逐字动画和刷新节奏，不保证渲染每个中间帧。
   - 官方插件 issue #194：全文一次到达，客户端仍逐字显示。
   - Python SDK issue #10：后台帧全部发完，客户端不渲染，过一会全部打出；评论称客户端中途崩溃，重新登录后内容完整，说明服务端内容是全的。
   - sunnoy issue #171：服务端计时在跑，客户端等待秒数一直停在 1 s。
   - 你的实际节奏约 0.7 s 一帧（250 ms 加约 450 ms 回执），14 帧约 10 秒。如果 finish 帧发出后客户端立刻跳到全文，基本就是这一条。
2. **回执其实已经报错但没检查 errcode。** 可能是 846607（频率）、6000（版本冲突）或 846608。请先确认第 15 帧之后回执的 errcode。
3. **限流把刷新帧计入的可能性低。** CowAgent（0.1 s）、LangBot（0.3 s）、WeKnora（0.3 s）、sunnoy（1 s 计时）长期以远超 30 帧/分的频率刷新，未见相关报错；Hermes 明确按"中间帧不计"设计。但若同一分钟内你反复测过几轮，剩余配额恰好十几条也说得通，所以仍要看 errcode。
4. **内容未变或只有不可见字符的帧被忽略。** Hermes 和官方插件都有相应注释；如果测试内容每帧都有可见变化可排除。

**区分实验**
- 记录每帧回执的 errcode 和耗时。
- 间隔改成 1 s 和 2 s 各跑一次。
- 测试内容分别用"前缀追加"和"整段替换"。
- 观察 finish 后是否瞬间补齐。
- 手机端和桌面端各看一次。

## 来源

- [S1] 官方 Node SDK：https://unpkg.com/@wecom/aibot-node-sdk@1.0.7/dist/index.esm.js ；issue：https://github.com/WecomTeam/aibot-node-sdk/issues/5 、https://github.com/WecomTeam/aibot-node-sdk/issues/27 ；Python SDK issue：https://github.com/WecomTeam/wecom-aibot-python-sdk/issues/10
- [S2] 官方 OpenClaw 插件：https://github.com/WecomTeam/wecom-openclaw-plugin/blob/HEAD/src/monitor.ts 、https://github.com/WecomTeam/wecom-openclaw-plugin/blob/HEAD/src/message-sender.ts 、https://github.com/WecomTeam/wecom-openclaw-plugin/blob/HEAD/src/const.ts ；issue：https://github.com/WecomTeam/wecom-openclaw-plugin/issues/194 、https://github.com/WecomTeam/wecom-openclaw-plugin/issues/155
- [S3] sunnoy 插件：https://github.com/sunnoy/openclaw-plugin-wecom/blob/HEAD/wecom/ws-monitor.js 、https://github.com/sunnoy/openclaw-plugin-wecom/blob/HEAD/wecom/constants.js ；issue：https://github.com/sunnoy/openclaw-plugin-wecom/issues/107 、https://github.com/sunnoy/openclaw-plugin-wecom/issues/171 、https://github.com/sunnoy/openclaw-plugin-wecom/issues/57
- [S4] Hermes Agent：https://github.com/NousResearch/hermes-agent/blob/HEAD/plugins/platforms/wecom/streaming.py 、https://github.com/NousResearch/hermes-agent/blob/HEAD/plugins/platforms/wecom/send_queue.py 、https://github.com/NousResearch/hermes-agent/blob/HEAD/gateway/config.py ；PR：https://github.com/NousResearch/hermes-agent/pull/41771 ；issue：https://github.com/NousResearch/hermes-agent/issues/140043
- [S5] LangBot：https://github.com/langbot-app/LangBot/blob/HEAD/src/langbot/libs/wecom_ai_bot_api/ws_client.py ；PR：https://github.com/langbot-app/LangBot/pull/2564
- [S6] CowAgent（原 chatgpt-on-wechat）：https://github.com/zhayujie/CowAgent/blob/HEAD/channel/wecom_bot/wecom_bot_channel.py
- [S7] OpenAkita：https://github.com/openakita/openakita/blob/HEAD/src/openakita/channels/adapters/wework_ws.py 、https://github.com/openakita/openakita/blob/HEAD/docs/WEWORK_WS_IM_NOTES.md
- [S8] MateClaw：https://github.com/mateaix/mateclaw/blob/HEAD/mateclaw-server/src/main/java/vip/mate/channel/wecom/WeComKeepaliveScheduler.java 、https://github.com/mateaix/mateclaw/blob/HEAD/mateclaw-server/src/main/resources/docs/zh/wecom-tuning.md
- [S9] AstrBot：https://github.com/AstrBotDevs/AstrBot/blob/HEAD/astrbot/core/platform/sources/wecom_ai_bot/wecomai_event.py
- [S10] Tencent WeKnora：https://github.com/Tencent/WeKnora/blob/HEAD/internal/im/wecom/longconn.go 、https://github.com/Tencent/WeKnora/blob/HEAD/internal/im/service.go
- [S11] multica：https://github.com/multica-ai/multica/blob/HEAD/server/internal/integrations/wecom/rate_limit.go
- [S12] 腾讯云 CodeBuddy 接入文档：https://cloud.tencent.com/document/product/1831/137051
- [S13] openclaw-china：https://github.com/BytePioneer-AI/openclaw-china/blob/HEAD/extensions/wecom/src/ws-reply-context.ts
- 企业微信官方文档：https://developer.work.weixin.qq.com/document/path/101463 、https://developer.work.weixin.qq.com/document/path/101031
- [F1] https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
- [F2] https://open.feishu.cn/document/cardkit-v1/card-element/content
- [F3] https://github.com/openclaw/openclaw/blob/HEAD/extensions/feishu/src/streaming-card.ts
- [F4] https://github.com/larksuite/openclaw-lark/blob/HEAD/src/card/streaming-card-controller.ts 、https://github.com/larksuite/openclaw-lark/blob/HEAD/src/card/reply-dispatcher-types.ts 、https://github.com/larksuite/openclaw-lark/blob/HEAD/src/card/flush-controller.ts

全程只读，没有写入或下载任何文件。
