# 资料互动与群文件查询

本批独立实现参考最新 QQApi `ea266f1` 已确认的普通 kernel 契约，不加载参考项目的原生库或脚本。目标版本仍为 Linux x64 QQ `3.2.35-54395`。接口可通过已配置的 HTTP、正向或反向 WebSocket 以及管理台消息调试使用，复用账号、会话、鉴权、超时和 `echo` 规则。

| action | 参数 | 返回与边界 |
| --- | --- | --- |
| `send_like` | `user_id`，`times` 默认 1；r16 源码范围 0–10 | 标准成功 `data: null`；先核对 UIN→UID，只派发一次，QQ 返回明确成功且实际成功数等于请求次数才成功。显式 0 原样派发，要求 `succCounts=0`，不改成 1 或本地 no-op。部分成功、超时、未知结果均失败，不自动补发。 |
| `get_group_at_all_remain` | `group_id` | QQ 实际 `can_at_all`、`remain_at_all_count_for_uin`、`remain_at_all_count_for_group`，附实际提示文字。零额度为有效结果。 |
| `get_group_root_files` | `group_id`，`start_index` 默认 0，`count` 默认 100、范围 1–100 | 根目录一页的 `files`、`folders` 及分页信息。 |
| `get_group_files_by_folder` | 上述分页参数，另需 `folder_id` | 指定真实目录的一页结果，不允许把目录标识当作宿主机路径。 |
| `get_group_file_info` | `group_id`、`file_id`，可选 `folder_id` 默认根目录 | 通过实时列表精确查找文件身份；目标目录最多读取 20 页、2000 条，与原动作共用截止时间。原生直接详情查询在目标 QQ 上超时，当前不使用该路径。 |
| `get_private_file_url` | `message_id` 或 `file_id`；可选 `user_id`、`file_hash` | `file_id` 只在本账号尚保留完整 record 的私聊记录中选择唯一文件；`message_id` 可按已保存 locator 刷新被裁剪的 record。可选 `user_id` 严格限定真实 peer；hash 省略或 `''` 不增加过滤，非空 opaque hash 精确匹配。歧义、失效、不完整或跨账号记录拒绝；刷新后在 native URL 请求前核对原消息、peer、element、UUID 与真实 hash。公共动作不自动回退 classic Offline。 |

`send_like` 的 r16 显式 0 补充仅完成离线验证，尚未部署或真实 QQ 验证；当前生产 r15 仍限 1–10。大于 10 的次数和参考的宽松数值转换仍未对齐，不依据参考注释推断 native 上限，也不把一次派发拆成多次点赞。

### r13 私聊文件参数与限定云验

正式[r13 兼容修复与云验汇总](../outputs/qqapi-compatibility-r13-cloud-acceptance-20261117.md)与最新[r3 覆盖台账](../outputs/qqapi-wave5r3-200-coverage-20261117.md)已生成；r2 台账与计数继续保留为历史快照。

[r13-r1 部署](../outputs/qqapi-wave5r13-r1-deployment-20261117.json)确认 Linux 全量 **1883/1883**；[运行镜像校验](../outputs/qqapi-wave5r13-r1-running-image-verification-20261117.json)确认 **176 个运行文件、8 个 WebUI 文件**一致，原 **legacy→17700、secondary→17701** 路由保留并连接。

[r9fid](../outputs/qqapi-wave5-privatefile-r9fid-cloud-acceptance-20261117.json)仅复用原 r7/r8rx 三条既有接收资源：每条四种成功参数为 `message_id+file_id+真实 user_id+原 hash`、仅 `file_id`、`file_id+user_id+hash`、`file_id+file_hash:''`，共 **12 个正向结果**；错误 peer（本号）与错误 hash 均走 `file_id` 路径，共 **6 个精确 retcode 1404 拒绝**。前两种成功变体各完整下载一次，合计 **6 次**，**60、852、852 字节各两次**与原 payload 逐字节及 SHA256 一致；后两种仅验证生产 URL 形状。总计 **18 次公开 action、2 次独立 RPC status、0 业务写入、0 history、0 验收工具 direct native 读取**。[外部守卫](../outputs/qqapi-wave5-privatefile-r9fid-external-guard-20261117.json)确认原容器、镜像、配置、两条路由和旧映射保持。

`file_id` 查找范围只覆盖本账号 retained 的完整 records；已裁剪 record 需使用仍有效的已知 `message_id`/locator 刷新，不能据此下载任意文件或恢复失效定位。早期 **56041 字节**样本仍见 `native-validation-20261116.md`，它本身不覆盖其他参数变体。r5 旧失败及 r7 接收端 0/3 保留，新验收不外推任意文件、账号、格式、classic Offline、完整入站导出或 AstrBot/plugin 传输，历史分层见[能力边界](capability-limits.md)。

### 群文件列表与其他查询

文件列表返回 `start_index`、`next_index`、`has_more`、`is_end` 与 `total_file_count`。`has_more=true` 时客户端继续传 `start_index=next_index`；不会悄悄截断大列表。每条文件返回真实 `file_id`、`busid`、`file_size`，名称、时间、上传者等仅在 QQ 确实提供时保留；不会编造默认上传者或时间。小于等于 JavaScript 安全整数上限的大小返回整数，更大 uint64 返回十进制字符串，避免精度损失。

列表原生方法的立即返回值是请求编号，不是成功码；即使编号为零也要匹配真实回调、群号和完整分页信息。旧会话回调不能满足新会话的请求。每个账号最多 8 个并行群文件列表请求，超时取消等待且不重新派发。

详情查询只在所选目录查到匹配的真实文件时成功；完整查完后报告该目录内未找到，超出扫描上限则明确失败，不把未扫描的其他目录当作不存在。测试群当前没有子目录，子目录参数已离线覆盖，真实子目录仍待有对应对象后验证。

上表群文件列表部分沿用早期查询批次的参数说明，私聊 URL 项已同步 r13。当前版本另已实现群文件下载 URL、空间与数量查询，以及目录创建/改名/删除、文件删除/移动/转存/改名等独立扩展，完整动作见 [能力矩阵](reference/capability-matrix.md)，限制见 [能力边界](capability-limits.md)。这些入口分别检查当前账号能力，不能由列表查询成功推断所有修改、权限和参数变体均已验证。已有上传扩展保持原有边界；查询失败不返回空列表冒充成功，缺少方法时返回不支持。
