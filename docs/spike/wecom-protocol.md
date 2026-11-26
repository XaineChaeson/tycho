# 企业微信智能机器人长连接协议（摘录）

来源：开发者中心《智能机器人长连接》（developer.work.weixin.qq.com/document/path/101463，页面更新 2026-04-01），2026-11-05 摘录。未实测；接通道前用真实机器人逐条核对，差异记回这里。

## 连接

- 地址 `wss://openws.work.weixin.qq.com`；凭据是 API 模式机器人的 Bot ID 与长连接 Secret（不是 Webhook 的 Token/AESKey）。
- 一个机器人只允许一条活动连接：新订阅会顶掉旧连接，旧连接收到 `disconnected_event`。
- 订阅帧：`{"cmd":"aibot_subscribe","headers":{"req_id":"…"},"body":{"bot_id":"…","secret":"…"}}`；响应带同一 `req_id`、`errcode`（0 成功）、`errmsg`。成功后不要重复订阅（有频率保护）。
- 心跳：`{"cmd":"ping","headers":{"req_id":"…"}}`，建议 30 秒一次；停了服务端会断开，超时值未公布。
- 断线重连由开发者实现；文档不给退避规则。

## 收

- 消息帧 `cmd=aibot_msg_callback`：`headers.req_id`（回复时原样带回）、`body.msgid`（去重键）、`body.aibotid`、`body.chattype`（`single`/`group`）、`body.chatid`（群聊才有）、`body.from.userid`、`body.msgtype`（`text`/`image`/`mixed`/`voice`/`file`/`video`）、文本在 `body.text.content`；非普通来源有 `body.compat_info.source`。媒体对象有 `url`（5 分钟有效）与 `aeskey`（AES-256-CBC，PKCS#7，IV 取 `aeskey` 前 16 字节）。
- 事件帧 `cmd=aibot_event_callback`：`body.msgid`、`body.create_time`、`body.from.userid`、`body.msgtype="event"`、`body.event.eventtype` ∈ `enter_chat`、`template_card_event`、`feedback_event`、`disconnected_event`。
- 每个请求都有带 `req_id` 的响应帧；文档没有要求对回调帧另行确认。

## 发（都走这条连接，长连接模式没有 HTTP 发送接口）

| 用途 | `cmd` | 关键字段 | 时限 |
|---|---|---|---|
| 欢迎语 | `aibot_respond_welcome_msg` | 事件的 `req_id`、`body` | `enter_chat` 后 5 秒内 |
| 回复 | `aibot_respond_msg` | 消息的 `req_id`；`body.msgtype="stream"`，`body.stream.{id,finish,content}` | 首帧起 10 分钟内 |
| 卡片更新 | `aibot_respond_update_msg` | 事件的 `req_id`；`body.response_type="update_template_card"`，`body.template_card` | `template_card_event` 后 5 秒内 |
| 主动推送 | `aibot_send_msg` | 新 `req_id`；`body.chatid`、`body.chat_type`（1 单聊 2 群聊）、`body.msgtype` 与对应对象（如 `markdown.content`） | 用户先和机器人说过话 |

- 回复 `msgtype` 支持 `stream`、`template_card`、`markdown`、`file`、`image`、`voice`、`video`。同一 `stream.id` 重发即刷新，`finish=true` 结束。
- 对消息的回复允许在回调后 24 小时内；回复加推送每个会话每分钟 30 条、每小时 1000 条。

## 对 tycho 的含义

- ~~Node 24 自带 `WebSocket`，零依赖可接。~~ 真机实测连不上，改用 `channels/ws-client.ts`，见文末。
- 终稿与通知用 `aibot_send_msg`（markdown）；对用户消息的回复用 `aibot_respond_msg` 的 `stream` 流式刷新（2026-11-05 改，见 `channels/wecom-stream.ts`）。流的寿命按 6 分钟处理，不是上表的 10 分钟。
- 问题消息用 `template_card` 加按钮；按钮回调是 `template_card_event`，5 秒内必须 `aibot_respond_update_msg`（把卡片改成"已回答"或"问题已关闭"），答案本身走账本 `answerApproval`。
- "登录"文字命令 → 回一条含一次性链接的 markdown。
- 一机器人一连接：服务重启顶掉旧连接是预期行为；两份服务同时跑会互相顶，`disconnected_event` 要当作致命错误报告而不是重连。

## 真机核对记录

### 2026-11-05：握手与响应帧

- **握手头名大小写敏感。** 网关只认 `Sec-WebSocket-Key` 这个拼写；请求里写成全小写 `sec-websocket-key` 时回 `HTTP 404`。Node 24 内置的 `WebSocket` 发的正是全小写，所以连不上。逐项试过：只把这一个头名改成小写就 404；`Connection`、`Upgrade`、`Sec-WebSocket-Version` 小写无影响；扩展头、`User-Agent`、`Accept-Encoding` 等都无影响。对策：`channels/ws-client.ts` 用 `node:https` 自己握手并按 RFC 的拼写写头名；`tests/wecom-gateway.mjs` 的假网关同样只认这个拼写。
- **网络。** 本机直连可达（经 TUN）；客户端不支持 HTTP 代理。
- **响应帧形状。** 未订阅时发 `ping`，回 `{"headers":{"req_id":"…"},"errcode":846609,"errmsg":"aibot websocket not subscribed, …"}`：响应没有 `cmd`，靠 `headers.req_id` 配对，`errcode` 非 0 即失败，与实现的假设一致。

### 2026-11-05：流式回复

- **内容是替换。** 同一 `stream.id` 先后发"甲""乙""丙""丁"，气泡最后只显示"丁"；每帧必须带全文。
- **回复凭据可复用。** 一条回调的 `req_id` 在断开重连后的新连接上仍可用；同一 `req_id` 可以先后开多个 `stream.id`，各成一个气泡。
- **回执只带 `req_id`。** 同一 `req_id` 上并发发帧时回执无法配对。协调者的探测脚本因此在连续快速刷新的第 14 帧停住，流没有收尾，气泡一直显示输入中。实现必须单帧在途。
- **断开期间的入站消息不补发。**
- **结束后的样子。** 定稿的流是一条普通消息，底部有"内容由AI生成"和点赞、点踩。
- **`channels/wecom-stream.ts` 的状态机对真网关跑通一个模拟回合：** 占位帧、排队提示、两条工具行、正文增长、定稿，共 10 帧，全部 `errcode=0`，回执 210–400 毫秒，正文帧间隔 1 秒。屏幕观感（思考区折叠、Markdown 渲染、正文里出现 `<think>` 字样）待用户在客户端确认。
- **企业微信客户端会识别模拟输入。** 用桌面控制在聊天框里输入并发送后，客户端弹出"当前设备环境异常"并要求手机扫码。不要用桌面控制操作企业微信。

### 2026-11-05：手机客户端所见（用户截图）

- **定稿气泡渲染正常。** 列表、行内代码、链接都按 Markdown 显示；正文里的 `<think>` 字样原样显示，没有打乱气泡。
- **完整链路通。** 手机发"测试"，总控回复"收到，通道正常。"到达同一会话。回复太短，看不出逐步出现的过程，长回复的观感仍待确认。
- **"登录"的回复到达，链接打不开。** 当时没有配 `http.publicUrl`，链接是 `http://127.0.0.1:…`，手机报 `ERROR_CONNECT`。回复现在会说明这种链接只能在主机本机打开；手机要能打开，得先有手机够得着的地址。
- 问题卡片和按钮还没有在真机上点过。
