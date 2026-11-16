# 资料互动与群文件查询

本批独立实现参考最新 QQApi `ea266f1` 已确认的普通 kernel 契约，不加载参考项目的原生库或脚本。目标版本仍为 Linux x64 QQ `3.2.35-54395`。接口可通过已配置的 HTTP、正向或反向 WebSocket 以及管理台消息调试使用，复用账号、会话、鉴权、超时和 `echo` 规则。

| action | 参数 | 返回与边界 |
| --- | --- | --- |
| `send_like` | `user_id`，`times` 默认 1、范围 1–10 | 标准成功 `data: null`；先核对 UIN→UID，只派发一次，QQ 返回明确成功且实际成功数等于请求次数才成功。部分成功、超时、未知结果均失败，不自动补发。 |
| `get_group_at_all_remain` | `group_id` | QQ 实际 `can_at_all`、`remain_at_all_count_for_uin`、`remain_at_all_count_for_group`，附实际提示文字。零额度为有效结果。 |
| `get_group_root_files` | `group_id`，`start_index` 默认 0，`count` 默认 100、范围 1–100 | 根目录一页的 `files`、`folders` 及分页信息。 |
| `get_group_files_by_folder` | 上述分页参数，另需 `folder_id` | 指定真实目录的一页结果，不允许把目录标识当作宿主机路径。 |
| `get_group_file_info` | `group_id`、`file_id`，可选 `folder_id` 默认根目录 | 通过实时列表精确查找文件身份；目标目录最多读取 20 页、2000 条，与原动作共用截止时间。原生直接详情查询在目标 QQ 上超时，当前不使用该路径。 |
| `get_private_file_url` | 本账号已保存的私聊文件 `message_id`，可选 `file_id` | 使用消息的原始 QQ 定位重新查询，校验唯一文件元素及其真实 UUID、校验字段，再请求下载 URL。未知、跨账号或无法唯一定位的消息失败，不接受仅凭任意文件 ID 下载。**目标 QQ 版本已通过 56041 字节私聊文件真实下载及校验；其他参数变体仍待验收，见 native-validation-20261116.md。** |

文件列表返回 `start_index`、`next_index`、`has_more`、`is_end` 与 `total_file_count`。`has_more=true` 时客户端继续传 `start_index=next_index`；不会悄悄截断大列表。每条文件返回真实 `file_id`、`busid`、`file_size`，名称、时间、上传者等仅在 QQ 确实提供时保留；不会编造默认上传者或时间。小于等于 JavaScript 安全整数上限的大小返回整数，更大 uint64 返回十进制字符串，避免精度损失。

列表原生方法的立即返回值是请求编号，不是成功码；即使编号为零也要匹配真实回调、群号和完整分页信息。旧会话回调不能满足新会话的请求。每个账号最多 8 个并行群文件列表请求，超时取消等待且不重新派发。

详情查询只在所选目录查到匹配的真实文件时成功；完整查完后报告该目录内未找到，超出扫描上限则明确失败，不把未扫描的其他目录当作不存在。测试群当前没有子目录，子目录参数已离线覆盖，真实子目录仍待有对应对象后验证。

本文前述列表是早期查询批次的参数说明。当前版本另已实现群文件下载 URL、空间与数量查询，以及目录创建/改名/删除、文件删除/移动/转存/改名等独立扩展，完整动作见 [能力矩阵](reference/capability-matrix.md)，限制见 [能力边界](capability-limits.md)。这些入口分别检查当前账号能力，不能由列表查询成功推断所有修改、权限和参数变体均已验证。已有上传扩展保持原有边界；查询失败不返回空列表冒充成功，缺少方法时返回不支持。
