# 已有接口参数与返回契约核对

2026-11-16 对照只读 SnowLuma 2.4.2 源码核查已有入口。本次调整沿用现有真实业务链，不新增任何云写验证，也不把参考实现的本地缓存、占位数据或随机消息哈希作为本项目真实证据。

已修四处兼容差异：

- `get_ai_characters` 添加参考的 `{type,characters:[{character_id,character_name,preview_url}]}` 字段；全部来自 QQ 实际 `category/voices/voiceId/voiceDisplayName/voiceExampleUrl`，同时保留旧字段。缺少真实角色 ID、名称或试听 URL 时明确失败，不生成假值。
- `get_group_shut_list` 添加 `user_id/nickname/shut_up_time`，对应真实 `uin/nick/shutUpTime`。原字段保持兼容；仍先验证完整成员列表及实际禁言时间，不以缺字段当成空名单。
- `_del_group_notice` 接受 `fid` / `notice_id` 别名，`fid` 非空时优先；空 `fid` 回落到 `notice_id`。两者显式存在时均先验证类型和边界，再派发一次已存在的固定删除操作。
- `rename_group_file_folder` 接受 `new_folder_name` / `name` 别名，前者非空时优先。任一显式别名类型不合法时写前拒绝，真实目标、回读确认和单次派发语义沿用现有实现。

随后补齐的文件契约：

- `rename_group_file` 接受参考的 `current_parent_directory`，前者非空时优先于旧参数 `parent_directory`，缺省 `/`；原生精确确认后返回 `{ok:true}`。
- `delete_group_file` / `move_group_file` / `rename_group_file` 省略 `busid` 时，先从原群、原目录、精确文件 ID 查询真实 `fileInfo.busId`，所有批量文件均验证完毕并再次确认账号会话后才执行一次写入。明确给出的合法 bus ID 继续沿用，不将 0 或 102 作为缺省值。删除支持可选 `folder_id` 作为源目录；省略时查询根目录，查不到明确失败，不扩大到任意目录或其他群。
- 文件上传只有在已确认消息中实际取得非空、有界的文件资源 `fileUuid` 后才返回成功 `file_id`。资源身份不完整时返回 `INVALID_RESPONSE`、不自动重发；已经发生的真实消息映射保留，普通消息 ID 不充当资源 ID。

仍需独立完善的差异：

- `get_group_file_system_info` 目前仅提供真实 `total_space/used_space`；参考还要求真实 `file_count/limit_count`。现有 native 批量计数只返回当前数量，不能编造容量上限。需要独立固定 `0x6d8_2` 计数/上限协议并验证。
- `get_essence_msg_list` 目前返回原生 Web 精华条目及单页结果；参考读取全页并投影 `sender_id/operator_id/operator_nick/operator_time/content/message_id` 等字段。可直接映射已存在的普通字段；本项目的短消息 ID 必须对应真实 native 消息定位，不能照抄参考的哈希算法凭空制造可操作 ID。完整分页也须有界且不静默截断。
- 历史查询固定较旧方向、排除已消费锚点并返回独立游标；参考的 `reverse_order=true` 表示较旧且包含锚点、`false` 表示较新，允许 `count=0`。现有明确拒绝 `reverse_order=true`，这属于已文档化的语义差异，不能只翻转一个布尔值修复。
- `get_group_honor_info` 当前仅提供所选已验证分类；参考默认 `all` 并返回各分类及当前龙王。不能用空数组冒充未查询分类；需要逐分类真实查询并保留完整性证据。
- `get_forward_msg` 当前读取本账号实际观察得到的 opaque forward handle；参考支持直接资源 ID 及 `message_id` 别名。上传返回的真实 `res_id` 暂不能直接替代现有读取句柄。若扩展，应绑定当前账号实际上传资源及受控读回，避免开放任意资源探测。

以上是静态源码与离线契约审计，不代表每个原有入口都已经完全兼容，也不继承其他项目的真实 QQ 验收结论。
