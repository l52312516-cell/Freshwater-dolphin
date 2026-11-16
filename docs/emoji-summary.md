# 完整表情回应汇总

`get_msg_emoji_likes({message_id})` 使用当前账号消息库里的群消息定位，原生刷新该消息的 `emojiLikesList`，依次读取每种表情的全部 `getMsgEmojiLikesList` 用户页，再次刷新消息类别及计数。每类的去重用户数必须等于 QQ 消息记录计数，前后目录必须一致。不会把分页失败、重复用户、不前进的游标、缺失目录或计数变化当成完整结果。

为表达真实能力，本项目扩展原示例的数组契约，返回有来源与完整性说明的对象：

```json
{
  "message_id": -12,
  "source": "qq_native_message_record_and_user_pages",
  "complete": true,
  "completeness_scope": "qq_message_record",
  "snapshot_consistency": "matching_before_after_counts",
  "last_reaction_time_available": false,
  "emoji_likes": [{
    "emoji_id": "76",
    "emoji_type": 1,
    "count": 1,
    "last_reaction_time": null,
    "last_reaction_time_available": false,
    "users": [{ "user_id": 10000 }]
  }]
}
```

Linux QQ 3.2.35-54395 的原生消息表情条目仅包含 `emojiId/emojiType/likesCnt/isClicked`，用户页仅有 `tinyId/nickName/headUrl`；它们都没有服务端最后回应时间。因此该时间返回 `null`，不能使用消息时间、本地观察时间或 0 冒充。`complete` 的范围是 QQ 当前消息记录中的目录和逐类用户；前后计数相同不能提供服务端原子快照保证，也无法检测恰好同数量的并发成员替换。

明确的空目录仍须前后两次刷新一致，返回 `emoji_likes:[]` 及相同来源、完整性说明。当前限制：群消息、每次最多 64 类、每类 1024 人、总 4096 人、总 300 页、20 秒、2 个未完成查询。超过限制直接失败，不返回截断的完整结果。取消或更换会话后，未完成原生请求仍占用物理槽直到真正结算。

上述 20 秒为 helper 自身上限，实际仍受 OneBot/RPC 的更短剩余期限约束；默认普通 action 为 10 秒，不能从 helper 上限推断外部调用一定可等待 20 秒。

不使用 `0x9084_1` 最近使用表情目录替代消息摘要，也不把本地 reactionStore 当成全量服务端状态。本地测试覆盖分页完整性、双次刷新、空目录、计数变化、取消、会话与账号隔离；云端读取仅由主任务在授权测试群消息上验证。

2026-11-16，双账号各在自己新测试消息上添加一次 `76` 表态，真实汇总均返回 1 类、1 名本人用户、count=1，以及明确的时间 `null` 和目录完整性范围；随后清除表态并回读无用户。初始空目录、非空汇总与清理回读分别保留证据，14 个专项场景均通过。多个表情类别、多页用户及并发变更仍未做真实云验。
