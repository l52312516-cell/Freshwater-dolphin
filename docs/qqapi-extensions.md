# QQAPI 只读扩展

从 `0.2.0-alpha.3` 开始，新增下列六项独立查询，参考 NapCat 等 OneBot 扩展命名及可核实的 QQ kernel 契约实现。它们通过现有 HTTP、正向/反向 WebSocket 和管理台调试入口调用，复用账号授权、`self_id`、会话 epoch、总期限和 `echo`；不开放任意 kernel 调用。不宣称与其他实现的全部接口或参数完全兼容。

| action | 参数 | 真实查询与返回 |
| --- | --- | --- |
| `get_group_detail_info` | `group_id` | `getGroupDetailInfo(group_id,2)` 的受理结果与匹配群的详情回调；保留有界真实原生字段，并附 `group_id/group_name/member_count/max_member_count`。仅当原生返回时附 `group_remark/group_all_shut`，不编造备注或禁言状态。 |
| `get_group_info_ex` | `group_id` | 独立 `getGroupExt0xEF0Info` 查询，按返回 Map 的精确群号取扩展信息；不是 `get_group_info` 的别名。 |
| `get_group_shut_list` | `group_id` | 复用 `getAllMemberList` 的完整 `finish/ids/infos` 成员快照，缺详情或禁言时间时以每批最多 50 人的 `getMemberInfo` 补齐；全部成员均有真实 `shutUpTime` 后筛选仍生效的时间。每项返回参考字段 `user_id/nickname/shut_up_time`，由真实 `uin/nick/shutUpTime` 投影，同时保留这些原字段及 `uid` 和原生确有的 `role/cardName`；不透传 Map、宽整数等其它原生成员扩展。最多 10000 人，筛选前全体原生输出投影合计最多 1 MiB，不把缺字段或失败变为空列表。 |
| `get_profile_like` | 可省 `user_id`（当前账号）、`start`（0）、`count`（10，1–100） | `getBuddyProfileLike`，唯一匹配目标 UID，返回真实 `uid/time/favoriteInfo/voteInfo` 和计数、用户条目；查询不会点赞。 |
| `get_emoji_likes` | 本账号短 `message_id`、`emoji_id`，可省 `group_id/emoji_type/count/cursor` | 先刷新真实消息定位，再用其 peer、msgSeq 查询回应者；返回 `emoji_like_list`、`has_more/partial/next_cursor`、本次上限和读取页数。查询不会添加或取消回应。 |
| `get_collection_list` | `category`（0）、`count`（50，1–100）、`time_stamp`（字符串 `"0"`） | QQ 进程内取得固定 `weiyun.com` 域票据，请求官方收藏服务固定操作 20000；核对响应账号、序号、操作与业务码，返回真实 `collectionItemList/hasMore/bottomTimeStamp`。票据不经过 RPC，不修改收藏内容。 |

所有群号必须是精确正整数；不接受陌生参数。HTTP 表单/GET 的 `category/start/count` 按显式 schema 解码，64 位时间戳、消息原生 ID 和分页状态保持字符串，不进行浮点数推断。显式传入 `null` 不作为省略参数。

资料点赞的原生 `time` 在当前 Linux QQ 返回安全整数，部分接口声明为十进制字符串；两种精确表示均保留，不作强制转换。拒绝负数、非整数、不安全数字及超出 uint64 的字符串。

## 分页和消息归属

`get_emoji_likes.count=0` 或省略表示本次最多 150 人、10 个原生页，每个原生页 15 人，仍受动作剩余期限约束。数量达到上限或尚有原生页时，`has_more=true`，应以相同消息和表情参数携带 `next_cursor` 继续查询；不会把一页伪装成全量。页内剩余条目保存在游标中，切页不丢失已取回但尚未返回的用户。

回应游标使用 AES-256-GCM 加密和认证，绑定账号实例、QQ 身份、会话、原消息、peer、sequence、emoji/type；有效期十五分钟，worker 重启后失效。客户端应将游标作为敏感查询状态保存，不记录或公开。跨账号、切会话、变更目标或篡改游标明确拒绝。这里只接受本账号持久映射中的 OneBot 短 ID，不提供任意原生长 ID 的下载或查询入口。

收藏分页继续传上页真实 `bottomTimeStamp` 为 `time_stamp`，并保留相同 `category/count`。`"0"` 表示首次查询。一次动作最多读取 10 个服务页，每页最多 50 项，返回不超过请求 `count` 的一个公开页；分类在本地按真实条目筛选，游标保留完整已扫描页的最小修改时间，不截断后丢失条目。`hasMore=true` 表示仍有服务页，不保证下一页含有指定分类；扫描上限内未找到任何匹配项且服务仍有后续页时明确失败，不伪造空分类成功。

服务的结束标记是 uint32，零或缺失表示尚未结束，非零表示结束。空页必须含明确非零结束标记；`hasMore=true` 但没有可推进的时间戳或有效条目时视为无效响应。单个 HTTPS 响应最多 2 MiB，公开页和其业务状态合计最多 1 MiB，为文件 RPC 的 2 MiB envelope 留出余量。HTTPS 地址与操作固定，不跟随重定向；网络或业务失败不自动重试。

## 超时与并发边界

群详情和补充成员详情的回调没有 requestId。同操作同群查询可以共享受控观察，各调用者保留自己的期限；调用者超时不证明 QQ 已停止。内部观察窗口到期仍缺少必要回调时，该操作和群在当前会话进入未决状态，后续返回 BUSY，避免迟到旧回调被当成新请求。会话切换后重新核实状态，不自动重试旧查询。禁言列表使用完整成员快照，避免目标 QQ 中一直未结束的专用 `getGroupShutUpMemberList` 调用。

原生未决请求另有有界预算，额度直到真实 Promise 结束才释放；普通网络请求超时不会绕过这一限制。收藏、资料点赞、回应等查询同样检查当前身份和会话，迟到结果不得成为新会话结果。

原生响应在遍历时累计节点、深度和 JSON 字节预算，完整结果再核对上限；重复超大字符串也不能绕过预算。底层方法不存在、响应无明确成功、群号/UID/消息定位不符、响应不完整或分页不前进均失败。

## 验证范围

源码能力清单与当前账号 `get_capabilities` 分开记录。`available` 表示当前会话提供所需方法和监听，不能代替真实业务验收。空禁言/收藏/回应页仅证明该空页契约，不能证明非空条目或所有权限、分页和大小变体。云端结果随本版本验收摘要记录，不继承其他项目的成功标签。

2026-11-16 在 Linux x64 QQ `3.2.35-54395` 的两个云端账号上，旧原生 `getCollectionItemList` 均返回 `errCode=5`，该拒绝结果始终按失败处理。固定官方 HTTPS 链路随后返回身份与操作均匹配的成功响应、`totalCount=0` 与 uint32 结束标记 `215000`；用户独立确认两个测试账号均无收藏。结束标记按可核实参考契约的“非零结束”语义解码，未把旧原生拒绝码改写为成功。正式 HTTP/WS 动作验收以本次云端报告为准；非空收藏、分类、多页和所有八类摘要仅有离线契约测试，尚未云端验证。
