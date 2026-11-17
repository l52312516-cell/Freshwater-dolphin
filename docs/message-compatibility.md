# 消息兼容、部分内容与结构化日志

Freshwater 在接收和读取消息时，默认保留可以转换的内容，并在无法表示的片段原位置加入标准 OneBot `text` 占位。这样，图片、引用或新类型暂不可用时，同一条消息中的其他文字仍能到达机器人。占位表示内容不完整，不能证明该片段已成功解析、下载或转发。

## 读取入口与严格边界

| 入口 | 行为 |
| --- | --- |
| 实时消息事件、`get_msg` | 默认兼容转换；部分内容附带 `_freshwater` |
| 群聊／私聊历史 | 每条消息保留状态；结果根节点另有部分消息数量汇总 |
| `get_forward_msg`、`qqapi_get_forward_messages` | 逐节点兼容读取；`message` 与 `messages` 两种表示均保留节点状态，根节点汇总问题 |
| 合并转发资源的纯读取回退 | 仅对已经识别且边界合法的内容字段提供占位；资源结构、作者身份等仍严格校验 |
| `get_group_todo_list` 中缓存的消息字段 | 随消息保留部分内容标记 |
| 单条原内容重发、合并转发的出站校验 | 严格转换；不把已知的部分内容当作完整原文发送 |

底层 `codec.fromKernel()` 和转发资源 `read`／`readCustom` 保持严格语义。只有显式兼容上下文或纯读取 `readCompatible`／`readCustomCompatible` 可以生成占位；出站语义核验使用严格入口。原生按原消息定位的精确转发不需要从占位文字重建原文，但仍须满足原有定位与权限要求。

兼容转换只接受已分类的内容问题，以及对应的 `UNSUPPORTED`、`NOT_FOUND`、`ENOENT` 错误。未知片段、提及或表情、不可读取的媒体、不支持的媒体格式可以形成占位；引用只有在结构完整、身份已验证而原消息暂时不可定位时才可以形成占位。缺少或冲突的作者、时间、客户端序号、原生消息 ID，或无法证明原消息身份的 `NOT_FOUND`，仍使整条操作失败并记录 `invalid_identity`。非法或冲突结构、错误账号、不安全路径、会话或运行配置拒绝、协议异常同样失败。整条消息在媒体、提及和引用查询之前完成结构预检，避免前半段内容成功就掩盖后半段非法参数。

QQ 原生类型 `8` 的灰条、控制与撤回记录不会变成普通占位消息；它们继续通过已有通知及历史过滤路径处理。文件元数据足够时可以形成完整文件段，缺少可下载 URL 本身不代表内容不完整。未知资源字段的占位不表示 Freshwater 已支持其协议。

## 返回字段

只在内容部分可用时增加 `_freshwater`。OneBot 的 `status`、`retcode`、`echo` 保持原有含义；读取接口可以返回 `ok`／`0`，同时明确标记内容为 `partial`。`raw_message` 始终根据实际返回的消息段生成，包含占位文字。

```json
{
  "message": [
    { "type": "text", "data": { "text": "之前的文字" } },
    { "type": "text", "data": { "text": "[暂不支持的QQ消息片段：类型99]" } },
    { "type": "text", "data": { "text": "之后的文字" } }
  ],
  "_freshwater": {
    "schema": 1,
    "content_status": "partial",
    "issue_count": 1,
    "issues": [
      { "element_index": 1, "element_type": 99, "reason": "unsupported_element" }
    ],
    "trace_id": "0123456789abcdef0123456789abcdef"
  }
}
```

`element_index` 从 `0` 开始，对应原生消息中的位置。`issue_count` 是问题总数，`issues` 最多保留前 `32` 项。根据问题类型，还可能包含 `media_type`、`at_type`、`face_type`、`wire_type`；合并转发根节点的问题包含 `node_index`。`trace_id` 在有请求或事件追踪上下文时提供，格式为 `32` 位小写十六进制。

受限资源解析产生的未知字段使用内部 `element_type: 0` 加实际 `wire_type`，显示为 `[暂不支持的QQ消息片段：协议字段51]`，不表示支持 QQ 原生类型 `0`。扩展不保存未知字段的原始负载。

其他占位文字包括：

- `[暂不支持的QQ提及：类型1]`
- `[暂不支持的QQ表情：类型6]`
- `[QQ媒体暂不可读取：类型4]`
- `[暂不支持的QQ媒体格式：类型4]`
- `[QQ引用消息暂不可定位：类型7]`

历史结果的根节点仅汇总，不重复所有问题：

```json
{
  "_freshwater": {
    "schema": 1,
    "content_status": "partial",
    "partial_message_count": 1,
    "issue_count": 2
  }
}
```

合并转发中，`messages[i]._freshwater` 与 `message[i].data._freshwater` 保留同一个节点的状态；根节点带完整格式的汇总问题和 `node_index`。资源展示节点不会因此获得虚构的原生消息 ID 或 OneBot 消息 ID。没有该扩展字段不能反推任意历史数据已完成内容校验。

## 机器人、快捷操作与缓存

忽略扩展字段的 OneBot 客户端仍能显示标准文字占位。需要保证原文完整的消费者应检查原始事件或 `get_msg.data._freshwater`。当前实现已完成本地定向测试，尚未核验实际安装的 AstrBot 是否完整保留该扩展；如果插件只复制文字段，Freshwater 无法从后续文字中区分占位和用户输入的同样文字。

部分消息不会触发或被内置 `#fd` 状态命令消费，而是继续投递给普通下游。快捷操作可以明确回复，但对部分消息的 `delete`、`ban`、`kick` 或部分请求的审批会在任何回复及副作用之前拒绝。通过 `.handle_quick_operation` 传入的消息上下文会从服务端消息映射重建，不能靠客户端删除或伪造完整性标记绕过检查。

缓存中的 `emitted` 只表示已经发布并完成去重，与内容完整性无关。部分消息复用原有账号和原生消息映射；之后查询或补齐内容不会自动重新推送事件。扩展保存在缓存事件内部，未新增映射版本或把 `emitted` 改为完整性标记。清理缓存或普通备份剥离正文时，扩展与正文一并移除，消息定位和已有去重标记仍保留；之后读取需要重新转换原生内容。

## 日志与排查

| 日志事件 | 含义 |
| --- | --- |
| `message_partial`（WARN） | 消息已接收，部分内容已用占位表示 |
| `message_skipped` | 整条消息被拒绝，没有把异常包装成正常占位消息 |
| `action_failed`（ERROR） | 接口失败；结合 `reason`、子阶段和 `traceId` 定位 |

部分消息的消息日志行同样为 WARN，包含 `partial`、`partialCount` 和可用的安全追踪字段。管理台日志搜索支持 `traceId`。读取列表中的日志和 ID 映射只会在整个读取成功后提交，避免后续页项失败却先宣称已接受部分消息。

内容问题 `reason` 为 `unsupported_element`、`unsupported_mention`、`unsupported_face`、`media_unavailable`、`media_format_invalid`、`quote_unavailable`。其他失败可能是：

| 分类 | `reason` |
| --- | --- |
| 接口／版本／配置与能力 | `action_unsupported`、`version_unverified`、`runtime_profile_denied`、`experimental_operation_disabled`、`native_profile_mismatch`、`capability_missing` |
| 输入／身份／会话 | `invalid_structure`、`invalid_identity`、`event_session` |
| 协议／业务与不确定结果 | `protocol_response_invalid`、`business_rejected`、`outcome_unknown` |
| 部分来源的写入限制 | `partial_source_not_sendable`、`partial_quick_operation` |

结构化诊断只允许固定的阶段、类型、位置、数值业务码和安全追踪 ID 等白名单字段。IPC 发送与接收都会过滤，新增诊断不包含原始消息负载、下载 URL、Cookie、令牌或任意原生错误对象。`business_rejected` 表示 QQ 业务层拒绝，不能因为相同接口曾成功就当作“方法不存在”；例如语音数据格式错误用 `media_format_invalid` 和 `media_parse` 区分。

占位是显示回退，不是写入成功或自动恢复。发送、上传、合成和其他写入出现结果不确定时不会自动重试，以免产生重复消息或重复资源。对不支持的版本和能力，应结合实际账号的 `get_capabilities` 与运行配置查看，不根据单条 WARN 推断所有消息接口均不可用。
