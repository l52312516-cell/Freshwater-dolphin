# 联系人与杂项扩展

这些动作使用固定 QQ 业务契约，通过现有 OneBot HTTP、WebSocket 和管理台调试入口调用。它们复用账号授权、`self_id`、会话绑定、总期限及 `echo`，不提供任意 SSO、OIDB、kernel 方法或原始封包入口。目前只有离线契约与失败边界测试；真实业务验证范围以云端报告为准。

| action | 参数 | 返回与实际链路 |
| --- | --- | --- |
| `translate_en2zh` | `words`：1–50 个非空字符串，总计最多 16 KiB，单项最多 4 KiB | 固定 `0x990_2` 英译中，返回 `{words:[...]}`；结果数量与原词一一匹配。服务返回原词或语言标识时逐项核对，翻译业务失败不当作空列表。 |
| `get_unidirectional_friend_list` | 无 | 专用 `MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0` JSON 契约，返回单向好友数组。请求与参考契约相同，固定读取首屏最多 99 条；不宣称完整账号清单，尚无经过核实的后续分页契约。只输出服务实际给出的 `uin/uid/nick_name/age/source`，不编造缺失年龄或来源。 |
| `set_input_status` | `user_id`；可省 `event_type`，默认 `0` | 核对 UIN→UID 后执行固定 `0xcd4_1` 私聊输入状态；成功返回 `{}`。事件类型为 uint32，零值保留。成功仅证明服务确认操作，不能证明对方界面已经显示。 |
| `_mark_all_as_read` | 无 | 调用当前 QQ 的 `setAllC2CAndGroupMsgRead()`，仅明确 `result=0` 时返回 `null`；void、缺少状态或非零状态均失败。会影响当前账号全部私聊与群聊的已读状态。 |
| `get_doubt_friends_add_request` | 可省 `count`，默认 `50`，范围 1–100 | 独立 `0xd69_0` 过滤好友申请收件箱，不是普通好友申请的子集。返回本屏数组，`reqTime` 保持精确字符串；Linux 数字账号与 UID 两类响应均识别，再核对另一种真实身份。 |
| `set_doubt_friends_add_request` | `flag`；可省布尔 `approve`，默认 `true` | 仅接受上项返回的本账号、本会话短期 opaque flag。派发前重新读取过滤收件箱、核对同一申请人与时间。批准使用 `0xd72_0`，拒绝使用 `0xd69_0` 的删除操作，成功返回 `null`。 |
| `get_group_ignore_add_request` | 无 | 固定过滤收件箱 `0x10c0_2`，返回入群申请条目；不从普通收件箱猜测“被忽略”状态。 |
| `get_group_ignored_notifies` | 无 | 同一固定过滤收件箱，返回申请及邀请条目数组。普通收件箱的 `0x10c0_1` 不在本族可选操作内。 |

群过滤收件箱每个服务页最多 100 条，通过真实 uint64 游标继续读取，最多 10 页。重复游标、重复申请、不推进、超限或任何中间页失败均整体失败，不返回半份清单。公开 `request_id` 保持十进制字符串，避免原生长序号经过浮点数而失真；缺失参与者身份不会写成虚假的 QQ 号 `0`。`get_group_ignore_add_request` 仅保留线协议事件类型 `1`（QQ 通知类型 `7`）的入群申请；另一个动作同时包含线协议类型 `2` 的邀请。

过滤好友 `flag` 有效期十分钟、工作进程重启或会话切换后失效；未取得可核实申请时间时返回 `flag:null`，该项不能通过本接口审批。它与普通好友请求 flag 分开，不能传入任意 UIN/UID 替代。一个 flag 派发一次后不允许再次审批；超时不能证明服务未执行，不自动重试，也不因重新查询同一请求而生成新的可重放 flag。

每个账号同时最多保留八个尚未实际结束的本族操作，调用者取消、超时或切换会话不会提前释放仍在运行的底层请求额度。动作总期限十秒，单个协议响应和公开结果分别最多 1 MiB，原生字段数与字符串大小另设上限。没有方法、凭据、身份、业务确认或完整结果时明确失败；来源错误信息、原始封包及无关原生扩展不透传给客户端。

契约参考为 SnowLuma 的 `translate-en-to-zh`、`get-unidirectional-friend-list`、`get-doubt-buddy-req`、`approve-doubt-buddy-req`、`reject-doubt-buddy-req`、`fetch-group-requests` 独立协议模块，以及 NapCat 的 `setAllC2CAndGroupMsgRead` 原生入口。运行时只依赖本项目实现，不载入参考项目。
