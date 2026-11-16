# 原 18 项接口的替代实现

本轮在上一轮 `0327914` 的基础上接入原 18 个名称的实际行为。源码入口和离线契约可核对；云端真实业务验收按账号、场景分别记录，不能由接口存在推断全部可用。

| 接口 | 替代方法与边界 |
| --- | --- |
| `_get_model_show`、`_set_model_show` | 固定 QQ VIP 13030/13031；真实列表与严格业务 ACK。历史服务和 Linux 空 IMEI 的当前兼容性单独验证，未云写资料。 |
| `.get_word_slices` | 本地 ICU 分词，完整保留输入，明确不调用 QQ。 |
| `bot_exit`、`set_restart` | 单账号管理器，HTTP/正反 WS 完成响应后才提交持久意图；异步受理，不使用全局 process.exit。 |
| `clean_cache` | 只清理登记的非活动文件流缓存，保留登录、数据库、消息映射及恢复文件。 |
| `get_clientkey`、`get_cookies`、`get_credentials`、`get_csrf_token` | 真实 QQ 票据与固定 QQ 域的登录 CookieJar，按当前账号校验，正确区分 skey 与 p_skey 的 CSRF。 |
| `request_decrypt_key` | 仅读当前账号可信目录内数据库头的 salt，通过固定 0xcde_2 请求数据库 key；不是通信流量密钥。 |
| `send_packet` | 真实原生 SSO 串行队列及请求 ID 关联；限制命令/字节/时限，rsp=false 只代表提交。 |
| `nc_get_packet_status` | 返回适配器原生 SSO 的真实聚合对象，替换参考 null；不声称统计 QQ 全流量。 |
| `check_url_safely` | 固定 0xBCB_0，只由 QQ 检查 URL，本进程不访问目标；严格校验原 URL 与风险字段。 |
| `create_collection` | 原生 createNewCollectionItem，本账号作者、输入摘要绑定、严格 result/errMsg，不造收藏 ID；未云写收藏。 |
| `get_msg_emoji_likes` | 新鲜消息记录目录、逐类用户终页、计数前后双刷；返回带来源和完整性范围的对象。最后回应时间缺少真实来源，明确为 null。 |
| `set_group_anonymous`、`set_group_anonymous_ban` | 历史固定 OIDB 开关、固定 QQ Web 匿名禁言；必须有业务 ACK，当前服务可用性未云写验证。 |

详细契约见 [鉴权与数据库](auth-extra.md)、[生命周期与缓存](lifecycle-actions.md)、[原始包与统计](raw-packet.md)、[型号展示](model-show.md)、[URL 安全](url-safety.md)、[收藏创建](collection-create.md)、[表情汇总](emoji-summary.md)、[匿名管理](anonymous-actions.md)、[本地分词](word-slices.md)。

本轮测试报告保存在工作区 `outputs/qqapi-remaining-*`。凭据、数据库密钥、salt、原始包、账号群号和消息正文不进入报告。云测不执行账号退出/重启、资料设置、群设置、成员禁言或收藏创建。

## 当前目标环境验收

2026-11-16，Linux x64 / QQ `3.2.35-54395` 的最终第二轮完整测试为 **1639/1639 通过、0 失败、0 跳过**。原生模块验证通过，运行镜像中的 170 个源文件哈希一致；镜像 `freshwater-dolphin:qqapi-remaining-r2-20261116` 已部署，完整镜像 ID 为 `sha256:4ab6feaefe7cd814d55f36708dce23f14cab6141b832f461f5dd0cea8967d85d`。旧容器保留用于回滚。

两个既有测试账号各执行 23 个真实场景，共 **46/46 通过**，其中每账号 3 个场景是参数/路径拒绝边界，不能计为 QQ 正向业务。两个账号的旧消息映射分别为 99、98 条，部署和测试后均完整保留，账号保持 ready/online/authorized。创建的临时文件已清理。

| 原 18 项 | 真实验收结果与限制 |
| --- | --- |
| `get_clientkey`、`get_cookies`、`get_csrf_token`、`get_credentials` | 双账号通过；四个固定域 Cookie 均绑定本账号，CSRF 按真实 key 计算。密钥正文不进入证据。 |
| `request_decrypt_key` | 双账号从当前账号真实数据库头请求取得非空 key；越界路径拒绝。没有执行整库解密，不能视作数据库恢复验收。 |
| `send_packet` | 双账号使用已验证的只读 rkey 请求取得真实原始响应并成功解码；别名的 `rsp=false` 只验证物理提交。未测试任意其他命令。 |
| `nc_get_packet_status` | 双账号请求、响应、字节计数实际递增；仅适配器原生 SSO 范围。 |
| `.get_word_slices` | 双账号云端进程 ICU 分词成功，保留完整输入；不是 QQ 远程分词。 |
| `_get_model_show` | 双账号真实 VIP 服务各返回 6 个型号选项；不推导写入也可用。 |
| `check_url_safely` | 双账号对官方 QQ 网址得到真实 `level:2`（未知）。只验证查询链路和未知等级，不表示网址已被判安全，安全/危险真实样本未验证。 |
| `clean_cache` | 双账号只创建本轮临时文件，清理后确认文件不存在，登录和消息映射保留。 |
| `get_msg_emoji_likes` | 双账号空目录及真实单表情/单用户均通过，用户精确匹配本人，计数与前后目录一致；添加的测试表态已清除并回读为空。多类、多页及并发样本未云验。最后回应时间仍为 `null`。 |
| `bot_exit`、`set_restart`、`_set_model_show`、`create_collection`、`set_group_anonymous`、`set_group_anonymous_ban` | 已有独立实现并通过隔离 Linux 测试，未执行真实账号写入。匿名历史服务与型号设置的当前业务 ACK 仍待实际授权范围内验证。 |

因此，原 18 个名称中有 12 个完成了上述范围的双账号正向云验，6 个保留为未执行真实写入；200 个参考名称均有源码实现，当前完整目录为 38 个标准名称和 172 个扩展名称。名称覆盖、会话能力可见和真实业务通过是三个不同结论。上一轮 QQ 版本门控关闭的 AI、闪传创建、图文 Ark 和两个独立转发上传别名共 6 项保持关闭，不因本轮名称覆盖而启用。

证据分别为 `qqapi-remaining-r2-linux-tests-20261116.log`、`qqapi-remaining-r2-native-verify-20261116.json`、`qqapi-remaining-r2-image-verification-20261116.json`、`qqapi-remaining-r2-deployment-20261116.json` 与 `qqapi-remaining-r2-cloud-acceptance-20261116.json`。第一轮 3 个短时序测试失败日志及验收脚本前置顺序错误的零场景记录也保留；修正测试使用阶段同步/模拟时钟，未削弱断言，最终第二轮全量通过。

表情非空专项为双账号各 7 个场景，共 **14/14 通过**，证据为 `qqapi-remaining-emoji-cloud-acceptance-20261116.json`。基础与专项合计 60 个场景通过，其中 6 个为预期拒绝。最终健康快照见 `qqapi-remaining-final-health-20261116.json`；管理器 healthy、AstrBot 测试容器运行，双账号保持新鲜的已授权在线状态。
