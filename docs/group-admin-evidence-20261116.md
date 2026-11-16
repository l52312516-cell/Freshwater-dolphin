# 群管理与待办扩展的实现边界

本记录对应 `SnowLuma-latest` 可执行 registry 和本项目独立实现，日期为 2026-11-16。源码契约和离线测试不代表目标 QQ 云端验证通过。

## 匿名接口

`E:/worke/snowluma.git/SnowLuma-latest/packages/onebot/src/actions/group-admin.ts:689` 和 `:706` 将 `set_group_anonymous`、`set_group_anonymous_ban` 明确放在 `No-op stubs` 下，handler 直接返回 `okResponse()`，没有协议或原生业务调用。对该参考的 protocol 与 groupAdmin API 检索未发现可复用的真实匿名操作。

本项目保留这两个标准名称的 `UNSUPPORTED` 结果，不注册成功实现、不把未修改设置报告为成功。后续若要开放，需有真实固定协议或 QQ 内核方法、精确匿名目标标识和可归属回执的证据。

## 固定只读协议

| 操作 | 固定命令 | 目标与数据验证 |
| --- | --- | --- |
| 群管理设置 | `0x88d_0` 与 `0xef0_1` | 详情群号和 robot item 群号精确匹配；请求与修改使用各自真实字段号；完整权限位保留在后端编排中 |
| 群分类标签 | `0x967c_0` | `group_class` 是分类号，允许 0；不是群号；结果有界并校验标签身份 |
| 群分享链接 | `0x9060_3` | `uinForm=1`，携带群号、短链开关和附加参数；`src_id` 是参考兼容参数，真实 wire 不发送它 |

待办列表继续使用本项目已有 `extendedQuery2/group.todos` 的 `0x9474_0` 实现，不复制第二套公开列表实现。

## 写入与读回

写动作只允许固定 operation、真实当前账号、会话 epoch、总期限和有界待处理请求。修改按群或分类串行；原生 Promise 未 settle 时，取消调用方或切换 epoch 不释放物理请求预算。

邀请策略采用 `appPrivilegeFlag` 与 `0x06100000` mask；上传相册、临时会话、创建群的拒绝位分别是 `0x1`、`0x10000`、`0x8000`，按真实原值合并，每项单独写入并读回。成员权限修改要求真实详情中的 owner UID 等于当前账号 UID。历史可见性按真实 mask `0x4` 写入，详情的 `0/1` 表示不能当作完整扩展位域覆写。搜索和 robot 只发送调用方提供的字段，读回同时检查未请求字段保持原值。加群问题与答案遵循参考的 4、5、55 语义，55 映射为 5，5 清空答案。

批量移出成员最多 20 人，必须预先校验全部目标身份与权限，再逐项复用现有单成员移出流程；发生错误立即停止，已确认项计数通过 `PARTIAL_RESULT` 明确报告，不自动重试未确认项。

待办 set/complete/cancel 固定为 `0xf90` 子命令 1/2/3，只接受当前账号消息库的真实短 ID。写入前刷新并验证群、native ID、QQ sequence 和实际观测到的 random。服务端 OIDB 回执必须匹配命令和状态；完成待办可能仍保留供其他成员查看的共享 banner，因此不把 banner 仍存在误判为失败，也不合成完成状态。

本批云端授权仅允许测试消息与临时文件，不包括修改群设置、成员关系或账号资料。因此这些群管理写入、待办写入和 `set_self_longnick` 仅做离线验证，云端写验收待独立授权。

## 离线验证

`tests/admin-actions.test.cjs` 共 38 项通过，覆盖全部 15 个公开动作、全部 15 种固定协议操作经真实 native channel 的序列化与关联解码、公共 `OneBotService.action` 分发、能力枚举、匿名动作明确返回 1404、HTTP GET 批量 `user_id` 数组及 form 布尔参数。`user_id` 数组只在 `set_group_kick_members` 解码，其他动作仍保留原有整数契约；显式 0、false、空字符串及文本形式的数字分别保留。

边界验证包括错误业务码、错误群身份、重复字段、未知 ACK body、会话替换、总期限与取消、物理 pending 预算、部分成功计数和单次写入不自动重试。与 group-files、profile-interactions、msf-native-channel、share-actions、query2-oidb、transports 一起运行的定向回归共 146 项全部通过，日志位于 `work/admin-actions-validation.log`。这些均为离线模拟原生回执，不代表群管理云端写入已验收。
