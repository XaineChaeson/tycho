# 飞书群聊桥接

桥接让指定飞书群的文本 @ 消息进入指定 Tycho 项目。完全匹配预设问题时，桥接直接回固定答案。其余请求通过 Tycho 入站来源交给项目总控。总控调用 `reply_to_inbound_source` 明确发布可公开答复后，桥接才把它发回原消息所在的话题。

## 配置

1. 在飞书开放平台创建并发布企业自建应用，启用机器人，申请接收群聊中 @ 机器人消息和以应用身份回复消息所需的权限。把机器人加进要使用的群，确认它可以在话题里回消息。在事件与回调中启用 Encrypt Key，选择「将事件发送至开发者服务器」，订阅 `im.message.receive_v1`。回调地址为你自己的 HTTPS 地址加 `/feishu/events`。查看 [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case) 和 [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。
2. 在 Tycho「入站来源」建立一个 `tycho-v1` 来源，只允许这些群实际需要的项目，打开「允许回传明确发布的回复」，签发来源密钥。保留来源 ID、密钥和对应项目 ID。群内可 @ 机器人的成员都能向该项目提交请求。按群成员可以接触的项目和资料设置授权。
3. 在桥接主机创建只允许服务账户读取的 JSON 配置。把下面的示例值换成实际值。群 ID 取事件的 `event.message.chat_id`，机器人 Open ID 取测试事件中 @ 条目的 `id.open_id`，租户标识取飞书应用所在租户的 `tenant_key`。用飞书开发者后台的事件调试功能核对这些值。

```json
{
  "appId": "cli_example",
  "appSecret": "飞书应用 App Secret",
  "tenantKey": "飞书应用所在租户标识",
  "encryptKey": "飞书 Encrypt Key",
  "verificationToken": "飞书 Verification Token",
  "botOpenId": "ou_example",
  "tychoOrigin": "https://tycho.example",
  "tychoSource": "01J00000000000000000000000",
  "tychoSecret": "Tycho 入站来源签发的密钥",
  "projectsByChat": {
    "oc_example": "01J00000000000000000000001"
  },
  "quickAnswers": {
    "支持时间": "工作日 9:00 到 18:00"
  },
  "port": 8791
}
```

4. 在 Tycho 源码目录用 Node.js 24.3 或以上运行桥接。反代只把上述 HTTPS 回调路径转发到桥接所在机器的 `127.0.0.1:8791`，保留请求签名头和原始请求体。桥接可从部署环境访问 Tycho 的签名入站端口与 `open.feishu.cn`。Tycho 与桥接同机时也可用环回 HTTP。飞书回调 URL 校验成功后，在已配置的群里 @ 机器人验证。

```sh
node scripts/feishu-bridge.ts serve /path/to/feishu-config.json /path/to/feishu-state
node scripts/feishu-bridge.ts status /path/to/feishu-state
```

## 验收

依次发送普通闲聊、@ 机器人加上一个预设问题、@ 机器人提交一个需要项目处理的问题。只有后两条收到回复，项目里只记录最后一条。项目总控的普通对话留在 Tycho，回到群里的是总控专为来源发布的那条文本。桥接用飞书的纯文本节点呈现回复，模型里的提及和 Markdown 写法按字面显示。已进入话题的消息沿用原话题。群不支持原话题回复时，状态会记录飞书错误码。[飞书消息内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json?lang=zh-CN)

每套应用、租户与 Tycho 来源运行一个桥接实例，重启使用同一数据目录。配置重绑影响新消息，队列里已收录的消息保留原项目、原消息 ID 和待发正文。从飞书消息 ID 得到的稳定入站事件号抑制重复提交。桥接使用飞书回复接口的 `uuid` 重试同一正文，第一次尝试后 55 分钟停止自动重试，给飞书的一小时去重窗口留出余量。遇到 `uncertain`，到原话题核对是否已发，再处理失败原因。还没提交过的消息在 24 小时内可首次提交。Tycho 响应不明时从首次提交起最多重试 45 分钟，低于其一小时的最小去重保留期。桥接最多读回执 24 小时，Tycho 设置的回执实际保留期也会限制回读。只有 Tycho 公开且能读到的回执会产生回复。

单次队列操作异常按事件记日志并退避，其他到期消息继续处理。检查 `status` 中的状态和原因，再核对原话题。

测试覆盖合成加密飞书回调、真实 Tycho 签名入站与回执、原消息话题回复请求和进程重启。上线前需在实际飞书应用和群验证权限及回程。
