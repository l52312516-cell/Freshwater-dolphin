# 转发资源扩展与整条消息表情汇总

`upload_forward_msg`、历史拼写 `upload_foward_msg` 和 `send_forward_msg` 共用 `message` / `messages` 输入别名；同一次请求只允许提供一个。所有节点沿用已有合并转发校验：当前登录账号作为作者、完整节点预检、最多 100 个节点、1000 个文本段和总计 64 KiB 文本。不会冒用其他 QQ 号作为作者。

QQ `3.2.35-54395` 的仅上传资源已真实取得资源并读回，但完整解压后的字节与提交内容不同，因此 `forwardUpload` 在该版本固定为 false。两个上传别名及 `send_forward_msg` 的无目标分支均不可用；worker 的直接上传入口也在读取服务端时间或调用原生上传前返回 unsupported。完整字节校验保留，不将已有资源 ID 或上传 ACK 当作内容已验证。

仅上传资源目前支持自定义文本节点。图片、既有消息 ID 节点和嵌套节点没有经过这一独立上传链的媒体/资源契约验证，明确返回 unsupported。禁止通过给自己发消息、生成卡片字符串或本地随机值代替资源上传成功。

上传固定使用 `trpc.group.long_msg_interface.MsgService.SsoSendLongMsg`；资源分组为私聊 `type=1+selfUid` 或群聊 `type=3+groupUin`。自定义显示节点的 sequence/random 只是长消息内部的节点元数据，不是已发送聊天消息 ID。时间来自当前 QQ 会话的 `getServerTime`。仅接受 QQ 实际返回的非空 `resId`，随后通过固定 `SsoRecvLongMsg` 从服务器读回，并核对完整解压后的原始长消息字节。任一节点、段落、作者、昵称、时间或元数据变化均不能被判为上传成功。

在满足完整内容校验的实现契约中，仅上传成功响应为 `{message_id:0,res_id,forward_id}`，其中两个资源字段是同一个真实服务端资源 ID；0 只表示没有发送聊天消息。资源上传成功不代表聊天消息送达，0 不能用于查询、引用、回应或撤回，也不能作为发送成功 ID。`upload_forward_msg` 请求提供群号时还返回 `group_id`，历史拼写别名不返回该字段。`send_forward_msg` 未指定目标时走相同的仅上传路径；群号/用户号为 0 的路由提示不触发发送。上述响应不是目标 QQ 版本已通过云验的承诺。

`send_forward_msg` 指定群或私聊目标时，复用现有完整合并转发发送、确认与持久短 ID 映射。仅在已确认的根消息实际含有相同资源后返回 `{message_id,res_id,forward_id}`。该路径保留已有文本/图片限制与真实私聊 UID 解析。自定义预览 `source` / `summary` / `prompt` / `news` 尚无经过验证的原生设置路径，传入时明确拒绝。群目标优先级与参考路由一致。

`send_forward_msg` 的动作可用性按 `mergeCustom` 或 `forwardUpload` 的真实状态计算，并分别公开 `variants.targeted_text_image_nodes` 与 `variants.upload_only_text_nodes`。目标发送由 `runMerged` 在派发前独立检查 `mergeCustom`，不受仅上传资源门控影响；无目标请求仍必须具有 `forwardUpload`。第四批真实测试群文字合并发送已通过；wave4r5 在上传门控关闭后，又对两个账号各执行一次目标群文字合并并取得真实消息 ID 与资源根。这一结果不覆盖无目标上传，也不覆盖未测的图片或其他目标变体。

物理上传一次只允许一个；调用方超时或账号切换不提前释放还在执行的资源操作。每个账号会话最多保留 128 个已进入上传的内容指纹，同一资源命名空间及完整节点内容不自动重传，避免未知上传结果被悄悄重复。每个固定 native 调用上限 10 秒，总操作上限 60 秒。资源读回的压缩/解压输出均限制在 256 KiB，拒绝压缩炸弹和不完整响应。账号会话变化使任何旧结果失效。

上传错误仅附固定阶段枚举；QQ 时间校验失败时另附 primitive/object 类型与整数范围类别，不带原始时间、对象键、资源 ID 或包内容。第四批最初诊断确认目标 QQ 的 `getServerTime` 返回毫秒十进制字符串，旧校验在上传前拒绝，未创建转发资源。现按该真实口径用 BigInt 除以 1000 取得秒，保留 uint32 上限校验，仅丢弃毫秒余数；已有精确秒值继续兼容，不用本地 `Date.now()` 代替 QQ 时间。wave4r4 的修复后验收已完成真实上传及读回，但在 `phase=verify-content` 因完整字节不一致失败；历史时间失败与内容失败均保留，不自动重试，也不继续创建资源。最终版本因此关闭该 QQ 版本的独立上传路径。

`get_msg_emoji_likes` 仅列在明确不支持的目录中，`implemented:false`、`available:false`；不注册业务实现，也不计入已实现接口数量。调用明确返回 unsupported。SnowLuma 参考实现读取本地 `reactionStore.summarizeMessage`，再补查已知表情的用户；这不能为本项目证明当前消息的全部回应。参考代码还明确标注 `0x9084_1` 是最近使用表情目录，而 `0x9083_1` 只能查询指定表情的用户。现有 `get_emoji_likes` / `fetch_emoji_like` 继续提供真实单表情分页；不能拿它们冒充整条消息汇总，也不能用当前时间、消息时间、0 或不完整事件缓存编造 `last_reaction_time`。

本批定向测试覆盖固定 wire、资源回包解析、上传后完整读回、命名空间、压缩上限、超时物理占位、账号变化、未知结果禁止自动重传、发送真实资源回传与上述拒绝边界。新增门控样本确认目标版本的直接上传不进入时间读取或原生调用，公共仅上传请求不派发，目标合并发送继续取得真实确认根消息。离线样本与真实失败均不能证明仅上传业务已闭环；wave4r5 最终验收仅检查能力和独立目标发送，没有再执行仅上传资源写入。真实证据保留于各批 `cloud-acceptance` 报告。

接线接口：`fixedForwardUpload -> src/qq/forward-upload-protocol.cjs`；`createForwardUpload(capture).upload` 对应固定 RPC `forwardUpload`；OneBot 动作分派使用 `runForwardExtra`。公共能力、RPC allowlist、schema 与服务接线由公共集成完成。
