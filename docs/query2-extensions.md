# 状态、在线设备、群待办与签到查询

本批固定实现不开放任意 SSO 命令、URL、原始 protobuf 或账号凭证。四项动作通过 `extendedQuery2` 进入当前已认证 QQ 会话，沿用 HTTP/WebSocket、鉴权、`self_id`、`echo`、取消和截止时间规则。

| action | 参数 | 真实数据来源与返回 |
| --- | --- | --- |
| `nc_get_user_status` | `user_id` | 固定 `0xfe1_2`、UIN 模式、属性键 `27372`；返回 `status`、`ext_status`，按属性键选择并核对响应账号。属性缺失、目标不匹配和业务失败均报错。 |
| `get_online_clients` | 可选 `no_cache: false` | 调用无参 `msg.getOnLineDev()`，同时要求明确成功 ACK 和 `onLineDev` 完整快照。返回 `{clients:[{instance_id,client_type,device_uid,device_kind}]}`。空数组必须来自真实回调。 |
| `get_group_todo_list` | `group_id` | 固定 `0x9474_0`，请求待办旗标 `1`；返回真实源消息序号、random、摘要，以及 QQ 实际提供的创建/更新时间。消失待办跳过，源 ID 与跳转 JSON 的消息身份必须一致。 |
| `get_group_signed_list` | `group_id` | 复用现有 QQ Web 认证，固定 POST 到 `qun.qq.com/v2/signin/trpc/GetDaySignedList`；中国时区当天、每页 100 人，校验连续 offset/total、唯一成员和排名，完整收集后返回 `{user_id,nick,time,rank}` 数组。 |

目标内核的在线设备条目仅观察到 `instanceId`、`clientType`、`devUid`。当前保留这三个真实字段，`device_kind` 根据已确认的 `clientType` 低字节映射为电脑、手机、Pad 或未知设备；**不把 `instanceId` 猜成 `app_id`，不把 `devUid` 猜成 `device_name`**。因此这两个常见兼容字段当前缺失，使用者应按上表读取实际内核字段。内核方法重放缓存，无法强制网络刷新，`no_cache:true` 明确失败。

待办的 `message_id` 仅查本账号消息存储里同群、同序号且可唯一定位的真实映射；已观察到 random 时还要匹配 random。不生成哈希短 ID，不伪造原生消息。没有真实映射时 `message_id:null`，没有已转换消息缓存时 `message:null`；仍保留服务端的 `message_seq`、`message_random`、`text`。缺失的创建/更新时间省略，不补零。

所有查询最多等待 10 秒。最多保留 8 个实际未完成查询；外层超时或切换账号不会释放仍未完成的原生请求槽。在线设备没有请求 ID，因此同一会话只派发一个未完成快照查询。会话改变、初始化撤销和关闭会取消其等待，旧观察器由会话与观察器代次隔离。

签到最多 100 页、10000 人、1 MiB 窄 JSON 结果。缺 page、登录式响应、页间 total 改变、未知 offset、重复账号或排名、超限等均失败，不把首 100 人冒充完整名单；认证 Cookie、clientKey、skey 和 p_skey 不进入 RPC 返回。待办最多 1000 条，固定响应最多 1 MiB，字符串及整数范围分别校验。

离线验证覆盖四动作贯通、真实 wire 字段、状态属性匹配、待办双身份、签到分页与中国日期、在线 ACK/回调、会话切换、物理请求槽和原群 Web 回归。真实目标 QQ 的验收范围应以当前验证报告为准；方法存在和离线通过不表示所有群、权限和数据变体均已云端验收。

2026-11-16 的目标云端签到响应已核实：HTTP 200、外层 `retCode:0`/`funcCode:0`，业务成功码为精确字符串 `Succ`，`page:[{offset:0,total:0}]` 且省略 `infos`。此形状表示明确的空名单，不能因其业务码不是字符串 `0` 而误拒绝。当前仅接受 `Succ`、精确数字 `0` 或字符串 `0`；其他符号码仍失败。此真实 scope 仅覆盖空名单；非空名单、100 人以上多页和所有群权限变体仍待真实对象验收。
