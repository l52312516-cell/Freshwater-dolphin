# QQ 与 OneBot 能力边界

公开验证概要见 [0.2.0-alpha.3 发布说明](releases/0.2.0-alpha.3.md)；内部执行记录不随源码发布。

本文列出当前源码的实际边界。`get_capabilities` 的 38 项标准动作、20 类标准消息段和 4 类事件是兼容性清单，不代表全部实现。`implemented` 表示存在实现，`available` 还取决于当前真实会话、QQ 方法和配置；离线测试通过不等于在当前目标 QQ 中验证通过。

首批 QQ 目标固定为 Linux x64、3.2.35-54395。其他 QQ 版本不自动猜测接口签名。以下新增能力都必须由对应账号的实际测试单独确认，不能继承旧项目的测试结论。

当前目录注册 210 个 action 名称，200 个参考名称均有源码实现，其中四项继续整项门控；名称数量不是云端业务通过数，也不代表参数完全兼容。最新冻结的r4 台账记录 122 个名称在已记录范围内通过，573 次历史动作中 519 通过、54 失败，另有 99 未执行和 8 次零动作初始化失败。历史失败保留，后续通过不改写原记录。

当前运行 r15：正式汇总及部署记录确认 Linux **1910/1910**，相册目录和媒体终页链双账号限定读取 **6/6**；两个账号各观察到 5 条唯一媒体、随后空终页。没有目录续页、照片内容下载或相册写入证明。r14 只完成构建，没有部署；运行镜像从 r13 直接升级为 r15。原身份、映射、私有目录/权限、AstrBot 配置/容器/插件代码与 legacy→17700、secondary→17701 路由保持。本文件另标注的 r16 输入兼容仍是待部署源码，不计为新增 QQ 业务通过。

历史 r13 **1883/1883**、r12 **1805/1805**、r9 **1793/1793** 及 r6 转发分层证据继续保留，具体范围见下文。2026-11-16 用户实测反馈防撤回正常，并停止该项独立验证；这不是自动化插件 live 撤回流程证据。secondary 后续恢复由用户手动解除 QQ 客户端风控并登录，未证明自动恢复；降低风控的重试、节流与状态提示仍见后续计划，本轮尚未实施。

## 消息与媒体

| 能力 | 当前实现与具体限制 |
| --- | --- |
| 文字、@、引用 | 保留段顺序和空白，私聊先转换真实 UID，引用刷新原始定位。发送只认对应 peer、关联 ID 和 `sendStatus === 2` 的确认。 |
| 普通表情 | 支持稳定的内置表情类型。动态贴纸、骰子和猜拳等需要额外元数据，不把它们伪装成普通表情。 |
| 图片发送 | 接受账户私有媒体目录内非空的 PNG/JPEG/GIF，以及规范 `base64://` 图片。单张及整条消息内嵌图片解码总量最多 10 MiB；读取真实尺寸和 MD5，再交给 QQ 原生上传。内嵌图片先转成本账号私有短路径，发送结束或失败后清除导入副本，不把 base64 放入文件 RPC。远程 URL、闪照和表情包输入仍不支持。 |
| 图片接收、`get_image` | 查询精确消息和 element ID；本地缺失时调用 QQ 的真实下载接口，先装等待者，再核对完成回调、错误码、大小、MD5 和目录。优先通过按账户签名的短期资源 URL 交付；官方图片 URL 缺少 rkey 时，优先从当前已登录 QQ 的原生通道获取，按账号会话及群聊/私聊缓存并在过期后重新查询。原生不可用时只使用显式配置的回退服务；没有真实 key 就明确失败。缓存实现、真实到期刷新与含图合并下载的验收分别记录。 |
| 文件上传扩展 | `upload_group_file`、`upload_private_file` 接受账户媒体目录内最大 50 MiB 的本地文件，上传到会话根目录，保留真实文件名并等待 QQ 发送成功；只有确认记录包含真实非空资源 ID 时才返回 `file_id`。资源 ID 缺失明确失败，不用消息 ID 代替，也不自动重发。暂不支持子目录、远程下载或任意宿主机文件。 |
| 文件消息段 | `file` 为扩展消息段，每条消息只允许一个文件段，不拆分混合消息。`get_msg` 和历史查询可返回真实文件 ID、文件名、精确大小。r4 TXT 及 r5 双账号各一次 TXT/PNG 均有发送端独立 native `sendStatus=2` 证据；r5 四次 URL 查询全部失败、下载 0 次；后续 URL-r3 仅对 secondary 原 r1 TXT 完成一次 59 字节正式 URL/完整下载，详见下文。入站群文件事件由 `groupFileUrl` 门控，私聊文件事件由独立的 `privateFileUrl` 门控；查询真实文件资源后附下载 URL，临时无法取 URL 时只保留有效元数据，不从文件名推测链接。此前私聊 URL 小文件下载样本保留于 native-validation-20261116.md；r4/r5 当轮均没有接收账号入站证明；后续 r7 三文件原接收端比较 0/3 保留，r8rx 对同三条既有接收记录公开读取 6/6、完整字节/SHA256 下载 3/3。完整入站事件导出和 AstrBot 传输仍未由这些样本验证。 |
| 语音、`get_record` | 出站支持账户本地 MP3/WAV/QQ SILK，以及规范 base64 输入；内联媒体合计最多 10 MiB，本地源文件最多 50 MiB、600 秒，时长和波形取自真实 PCM。工具和 native 方法均存在时 `can_send_record` 才为 true。入站先按真实消息和元素读取账号 native roots 内完整 SILK，校验大小及 MD5 后登记资源；只有 QQ 下载器实际可用时才尝试主动下载。`record.receive_scope` 明确区分 `account-local-only` 与 `account-local-or-qq-downloader`，没有文件且不能下载时明确失败。`get_record` 仅接受本账号已登记的语音句柄，导出 silk/wav/mp3/flac/ogg；压缩格式要求项目内 FFmpeg。返回容器内真实文件路径，不能将其当作跨容器下载 URL。真机结果以本轮报告为准。 |
| 视频 | 入站支持完整 MP4/WebM 原始文件下载，最大 50 MiB。本地缺失时经原生 MSF 通道（NTV2RichMedia `0x11ea_200` 群 / `0x11e9_200` 私聊）直接取官方视频 URL（本构建 JS `downloadRichMedia`/`getVideoPlayUrlV2` 均失败），仅从受限官方域名单次下载，接受描述完整范围的 Content-Range，验证大小、MD5、完整容器后交付短期签名 URL。出站支持本账号目录内最大 50 MiB、600 秒、4096×4096 的单视频轨 H.264 MP4，读取真实尺寸和时长并解码真实 PNG 封面，再交 QQ 上传并等待确认；只允许单个视频段，不转码、不生成默认元数据。真机结果以本轮报告为准。 |
| 合并转发、`get_forward_msg` | 接收真实 16 型或完整 multimsg Ark 根并登记账号及会话句柄；原生读取保留文字、普通表情、真实官方 HTTPS 图片和已观察的嵌套节点。图片按自身 appid 获取 rkey，不将子节点当作主会话消息下载。`get_forward_msg` 提供 `message` 与 `messages` 两种形状，`qqapi_get_forward_messages` 可刷新已知根；`get_msg` 可读取缓存，不能据此声称强制刷新。根绑定后仅在成功识别并严格验证 9/4 时优先返回原始 `resourceNodes`；识别前临时不可用或超出 1500ms 探测预算则保留原生结果，详见 [转发扩展](forward-extra.md)。自定义发送接受 1–100 个文字/base64 图片节点，不同真实作者或显式 time 要求 `mergeCustomMetadata`；r6 已通过双账号群/私聊文本和 PNG 样本的发送端与接收端查询。语音、视频及引用上下文无法完整恢复时整条失败；已有 `node.data.id` 合并仍因缺少可证明的目标 ID 关联在 OneBot/RPC 派发前关闭，普通 `qqapi_message_forward` 只返回 kernel 回执。 |
| 音乐卡片 | 出站接受 QQ/网易云歌曲 ID 或自定义链接、音频和标题；使用全局显式配置的签名服务，校验音乐卡片后签发绑定账号会话、目标和卡片内容的一次性桥接凭据，再调用 QQ 原生发送并等待确认。签名服务故障、篡改、跨目标、旧会话、重复凭据和超时均报错，不提供通用 JSON 后门。离线链路通过不能代替真实卡片验证；第三方签名服务可用性需单独核验。 |
| 分享与 JSON 卡片 | 入站合法 Ark JSON 以 `json` 段保留原文。固定 news 分享卡片虽能被 QQ 受理并查询，但两轮真机客户端均显示“发送者版本过低”，因此 `share` 出站停用并明确返回不支持，不能把保存成功当展示成功。实验模板与凭据校验仅保留离线测试，不提供任意 Ark 或音乐签名旁路。通用 JSON、XML 和位置等出站段仍不支持。 |

图片、语音和视频导出统一最多保留 1000 个文件、总计 200 MiB；达到限额时明确返回繁忙，不静默删除仍可能被引用的资源。文字和请求动作默认总期限 10 秒，媒体转换、收发和文件上传默认 60 秒，下游转换、下载和发送共用剩余预算，不分步骤重新计时。历史消息扩展只支持向较早方向分页，游标使用持久化 OneBot ID 或绑定账号会话的原始页面游标；原始 QQ 长整数序列以字符串和 BigInt 比较，分页完整性未知时 `has_more` 为 `null`。历史页跳过精确属于本账号的 `sendStatus === 0` 失败记录及已验证系统灰条，分别返回 `skipped_failed_count`、`skipped_system_count`；对已验证的原生撤回占位记录另返回 `skipped_recalled_count`，保留原始分页位置，不给未送达记录分配成功消息 ID。

## 群与用户操作

| 能力 | 当前实现与具体限制 |
| --- | --- |
| 好友、资料、群、群成员 | 保留实际返回的可选字段；完整列表和异步详情必须获得正确的真实结果，查询失败不会伪装成空列表成功。 |
| 撤回与撤回通知 | 撤回动作刷新原始记录并等待实际撤回更新。通知要求存在真实操作者 UID、原始定位和有效时间，使用原 OneBot ID，并单独持久化通知去重。pokerecall-r1 对本任务新发的一条私聊和一条群消息均取得双端通知、精确原生撤回占位及正 `recallTime`；这是独立 API 验收，未执行 AstrBot 插件验证。 |
| 戳一戳发送与通知 | 识别目标 QQ 版本的 `1061` JSON 灰条，将真实发起者和目标 UID 转换为 UIN，输出 `notify/poke` 通知。不会伪装为文字消息或分配消息 ID；按账号、会话、聊天和原始事件 ID 有界去重，未知灰条明确跳过。发送已实现 `friend_poke`、`group_poke` 及按 `group_id` 路由的 `send_poke`。pokerecall-r1 的两个群聊样本取得 API 成功及匹配 native 通知；两个私聊样本虽 API retcode 0，但观察窗口内未见匹配 native 通知，该旧批次具体原因未证。后续 poke-r2 两个新私聊方向均取得双端 native 与真实隔离 Event WebSocket 通知，但未验证既有 worker/AstrBot 传输；精确范围和参数边界见下文。 |
| 群名、全群禁言、成员禁言、退群 | 使用类型明确的普通 kernel 方法，参数和真实成员权限校验后等待结果；解散群未实现。 |
| 群名片、管理员 | 原生方法返回 void，因此先装成员等待者，再调用一次变更并刷新成员；只有当前 group/UID/UIN 和期望值匹配才成功。超时不自动重试。 |
| 踢人 `set_group_kick` | 使用已核实签名的普通 `kickMember`，不猜测 V2 标记。调用前核对完整强制刷新成员快照、真实 UID/UIN 和角色权限；只派发一次，再读取完整强制刷新快照确认该成员由存在变为缺席。void、请求编号和其他完成信息均不代表成功；明确非零错误拒绝，缺席未确认则失败或超时。目标原本不在群时返回未找到，不冒充本次成功。当前新增实现已离线验证，Freshwater 云端行为需另行验证，不能继承 QQApi 的结果。 |
| 专属头衔、匿名群能力 | 专属头衔新增固定 OIDB 永久设置（duration 省略或 -1），受当前账号能力与群主权限限制；真实目标测试另记。匿名群开关与匿名成员禁言已实现固定历史 OIDB / QQ Web 协议，能力标记只表示传输通道具备；当前 QQ 服务端是否仍开放及实际群修改结果尚未云验，详见 [群匿名操作](anonymous-actions.md)。 |
| 资料点赞 | `send_like` 先将真实 UIN 转换成 UID，固定一次 `setBuddyProfileLike` 调用；只在明确成功且实际次数精确匹配时返回成功，部分成功或未知结果不补发。r16 源码允许 `times=0..10`、缺省 1；显式 0 原样派发并要求真实 `succCounts=0`，不本地伪造成功。大于 10 仍未对齐，0 仅离线验证。 |
| `@全体`额度 | `get_group_at_all_remain` 从真实 group 服务返回权限和群／账号剩余次数，保留零额度和官方提示。 |
| 群文件列表和详情 | 支持根目录、指定目录分页与精确文件详情；列表需真实请求编号和匹配回调，保留分页和 uint64 文件大小。目录条目不计入 QQ 返回的文件总数。新增真实文件计数、根文件夹创建、文件夹和文件改名、文件移动/删除/转存及文件夹删除，严格核验嵌套业务回执及批量完整结果。`get_group_file_url` 经原生 MSF 通道（`OidbSvcTrpcTcp.0x6d6_2`）返回真实官方 `ftn_handler` 下载 URL，仅接受 `*.qq.com` 官方域；下载令牌短期有效，按次实时获取、不缓存。`get_group_file_system_info` 经原生通道（`OidbSvcTrpcTcp.0x6d8_3`）返回真实 `total_space`/`used_space`（uint64，超出安全整数以十进制字符串表示）；不含 `file_count`（用 `get_group_file_count`），不能把请求编号当容量。真机结果以接口云测报告为准。 |
| 自身资料及群备注 | `set_qq_profile` 支持昵称、签名与整数性别 0/1/2，`set_group_remark` 修改本账号群备注。实际修改先读取真实原值，修改后按身份、目标与请求字段核对回读；共同十秒期限内只读确认，确认前一字段后才发送后一字段。未知结果不重发或回滚，部分完成如实报错。r16 源码补齐无字段 no-op 和空/空白昵称，详见[资料输入](profile-inputs.md)；仍无真实资料云写。 |
| 群荣誉 | 新增固定官方 Web 查询 talkative/performer/legend/emotion；从当前登录账号取得票据，只在桥内使用 Cookie，校验账号、域、业务码和真实集合。all/strong_newbie 尚未提供；云测结果另记。 |
| clientKey、cookies、CSRF、credentials、数据库密钥 | 对应接口交付当前账号真实结果，仅允许固定认证域；数据库路径限定受管理账号的 QQ 根目录。会话对象、原生内存和带凭据的诊断内容不导出；数据库解密密钥不作为 QQ 通信密钥。详见 [鉴权与数据库契约](auth-extra.md)。 |
| 退出、重启与缓存清理 | `bot_exit`/`set_restart` 使用当前账号的管理器锁、授权和进程所有权流程，成功响应后异步 commit；响应至 commit 的崩溃窗口可能使操作未执行。`clean_cache` 仅清理本账号 manifest 登记的非活动临时文件，保留登录数据、消息映射及恢复日志。详见 [生命周期与缓存契约](lifecycle-actions.md)。 |

好友/群请求处理、备注、分组、最近联系人和已读能力由独立 social 模块维护，其实时状态以生成的能力矩阵和 `get_capabilities` 为准。审核先安装绑定真实申请的等待者，操作完成后主动只读刷新对应申请列表；刷新请求成功仍不能代替实际申请状态确认，超时后同一 flag 不重复派发。不能确认参数语义、请求有效性或最终状态时必须返回不支持/失败，不能假定执行成功。

## 此前转发与群文件扩展

以下整理此前转发、群文件及相关资料扩展的返回语义，不作为本轮新增数量统计。`get_forward_msg` 是标准动作，其余按能力目录各自分类；当前标准动作、已实现动作及扩展入口的总量以生成目录为准。逐项云端验收结果另外记录，不因存在实现就视为所有账号、权限或参数变体均已验证。

| action | 成功返回与确认范围 |
| --- | --- |
| `get_forward_msg` | 输入已观察到、绑定当前账号及会话的 `id`，返回 `message` 节点数组与兼容 `messages`；过期或其他账号句柄拒绝。 |
| `qqapi_get_forward_messages` | 输入已知 OneBot `message_id`，回读真实 16 型根消息，返回当前 `id` 及上述两种节点形状；可用已观察到的 `parent` 读取同一根下的嵌套节点。 |
| `qqapi_message_forward` | 将同一真实会话内的 1–50 个已有 `message_ids` 普通转发到唯一群或私聊目标。返回 `confirmed: true`、`confirmation: kernel_ack`、源 ID 与目标；没有目标消息 ID，也不代表收件端已收到或展示。 |
| `get_group_file_count` | 返回指定群的真实 `group_id`、`file_count`；不是空间容量。 |
| `get_private_file_url` | 支持 `message_id`，或仅以 `file_id` 查找本账号尚保留完整 record 的唯一私聊文件；`message_id` 路径可按仍保留的 locator 刷新已裁剪的 record。可选 `user_id` 严格限定真实 peer；`file_hash` 省略或 `''` 不增加 hash 过滤，非空值按 opaque 原值精确匹配。未知、失效、跨账号、歧义及不完整记录拒绝，刷新后在 native URL 请求前重新绑定消息、peer、element、UUID 与真实 hash。公共 action 默认走 UID-mode OIDB；经典 Offline 编解码保留，但不是公共自动回退。历史小文件下载成功及失败均保留；r5 四个新 TXT/PNG 样本的 URL action 全部 retcode 1500、下载 0 次；r9 的 URL-r3 仅完成 secondary 原 r1 TXT 的 59 字节正式 URL/完整下载；后续 r7 发送端三文件完整下载 3/3，原接收端比较 0/3 保留，r8rx 补齐同三条接收记录公开查询与完整下载 3/3。r13 的 r9fid 只对同三条接收资源验证四种成功变体及六次精确拒绝，范围见下文；均不能推为任意文件或参数变体可用。 |
| `create_group_file_folder` | 仅根目录创建；核对真实文件夹 ID、请求名称及 native GroupItem 的群号和类型后返回 `folder_id`。 |
| `rename_group_file_folder` | QQ 明确受理后，按原文件夹 ID 完整分页回读根目录，名称实际匹配才成功 `data: null`。默认 SDK echo 不能替代真实回读；总期限内只轮询查询，不重发改名。 |
| `delete_group_folder` | 核对明确的嵌套业务成功回执，成功 `data: null`；未知结果不重发。 |
| `delete_group_file` | 单文件或 1–100 个文件批量删除；成功列表必须精确覆盖全部请求且失败列表为空，成功 `data: null`。 |
| `move_group_file` | 采用真实源、目标目录与上述完整文件回执，成功 `data: null`；部分成功报错。 |
| `trans_group_file` | 返回 `group_id`、原 `file_id`、`save_busid`、`save_file_path`。QQ 可能将转存后的文件换成新 ID；必须按不透明 `save_file_path` 在新鲜目录记录中精确定位，再查询真实元数据。group-tempfiles-r1 已在 secondary 的新建目录/TXT 样本中验证转存后的完整 80 字节下载及 SHA256；返回 `save_busid` 与当前目录 `busid` 实测不同，后续采用重新查询的实际值。客户端展示及其他参数变体仍待验证；`save_file_path` 不是下载 URL。 |
| `rename_group_file` | 采用真实文件 ID、busid、父目录和新名称，核对明确业务回执及返回的可选文件身份，成功 `data: {ok:true}`。支持 `current_parent_directory`，非空时优先于 `parent_directory`，缺省根目录 `/`。 |
| `set_qq_profile` | 支持 `nickname`、`personal_note`、`sex`，实际修改须按本账号身份回读确认后成功 `data: null`；组合修改部分完成如实报错。r16 无字段输入只做 no-op，不是资料修改通过证据。 |
| `set_group_remark` | 修改当前账号的群备注，按群号回读确认实际值后成功 `data: null`；不是修改群公开名称。 |

合并转发中的图片必须具有真实官方资源定位；缺少 rkey 时优先从当前登录 QQ 的原生通道获取，再尝试显式配置的回退服务。没有可用真实 key 时返回 `RKEY_UNAVAILABLE` 等明确错误，不剥掉图片返回残缺文本。仅文字合并样本通过不能证明含图片合并通过，图片数为零时的下载校验也不是图片实测证据。合并内语音、视频、引用仍未验证。自定义合并节点允许文字/base64 图片，最多 100 节点、1000 段、64 KiB 文字及 10 MiB 合计图片；不同作者必须解析并交叉核对真实 UIN/UID，且与显式 time 一样要求 `mergeCustomMetadata`，不接受未验证作者、嵌套或任意路径/URL。已有 ID 节点实验实现只处理同源群 1–20 个不同持久 OneBot ID 的纯文字，不接受原生长 ID 或混合节点；目前正式变体禁用，即使全部 native 方法存在也不能启用。普通转发、自定义合并和已有消息合并分别验证，不能互相继承成功结论。

群文件修改动作都只派发一次，超时或不完整结果不会自动重试；读取动作的分页与详情查找仍有明确上限。删除、移动和改名省略 `busid` 时，先按原群、原目录和精确文件 ID 查询真实 `fileInfo.busId`，全部待操作文件查询核验后才派发一次修改，不猜测 0 或 102。删除可用 `folder_id` 指定源目录，省略时仅查询根目录。群文件下载 URL 与群空间容量已由原生 MSF 通道提供（见 `get_group_file_url`、`get_group_file_system_info`）；未提供真实契约的文件操作继续不支持。私聊文件新增 `get_private_file_url` 及事件接线，采用精确消息和文件身份绑定的固定查询，保留 UID-mode OIDB 与经典 Offline 服务的独立编解码。2026-11-16 的历史样本曾通过正式 OneBot 查询下载 56041 字节并核对大小和 MD5；这只属于该 UID-mode OIDB 样本，经典 Offline 备用通道仍失败。后续 r5 的四个新发 TXT/PNG 样本 URL 全部失败，不能将历史成功扩大为当前新文件或全部参数变体可用。群文件夹和文件的所有参数、批量及权限变体都需要单独实测，单个测试对象通过不能替代这些覆盖。

能力目录中的扩展段 `file.receive` 仅在真实会话就绪且 `groupFileUrl` 或 `privateFileUrl` 至少一个可用时为 `true`；`receive_contexts` 分别列出当前门控启用的 `group`、`private`，未就绪时为空，群文件能力不会暗中启用私聊文件。发送范围为 `send_contexts: ["private", "group"]`，并继续受账户媒体目录与 `file` 发送能力门控。`get_private_file_url`、`get_group_file_url` 与 `get_group_file_system_info` 使用各自独立能力。目录验证状态保留 `offline-tested`，方法存在和离线通过均不代替实际云端验收。

当前生产 r15 在 QQ `3.2.35-54395` 仍关闭四个未闭环动作：`get_ai_record`、`send_group_ai_record`、`create_flash_task` 和 `send_tuwen_ark`；该生产目录保留 `implemented:true`、`available:false`。待部署 r18 源码已修复闪传创建阶段 ACK 与主文件 appid，移除仅创建动作的版本硬门控，保留完整上传和精确元数据回读；创建尚待真实云验。wave4 曾同时关闭两个独立转发上传别名，历史失败报告继续保留；wave5 严格语义回读只允许已证头部规范化，节点顺序、作者、名称、时间及完整 MessageBody 均保持不变，两个别名和 `send_forward_msg` 无目标分支已在双账号 6/6 通过。`send_forward_msg` 仍按 `mergeCustom` 或 `forwardUpload` 计算整体可用性，并分别公开目标发送和仅上传变体；具体范围见 [转发扩展](forward-extra.md)。

转发业务证据为 metadata-r6 24/24、接收端 r6rx2 16/16 与 native 根 8/8、上传 r6 6/6、消息 r6 38/38 及 兼容性 r6 12/12。兼容性含 8 项预期拒绝，目录和参数拒绝不算新的正向 QQ 业务。历史 r9 云端 Linux 全量 1793/1793、0 失败、0 跳过；native 验证、176 项运行源码哈希及权限与部署保留检查均通过，两个账号的原目录、旧消息映射、17700/17701 分流路由及 AstrBot 配置、容器和插件代码保持。

r7 首轮 Linux 测试 共 1773 项，1767 通过、6 失败；失败来自新增 observer fixture 的 input/cache 目录默认 0755，被既有私有媒体目录检查拒绝。r7a 只将测试目录创建改为 0700 并增加 POSIX 所有者/权限断言，生产权限检查保持；r7a 1773/1773、0 失败、0 跳过。r7 失败日志及 r6 的 1766/1766 历史记录均保留。

privatefile-r4 两账号各派发一次 60 字节 TXT，公开动作共 4/4 通过，另各一次独立 native `getMessage` 精确核对发送者 UIN/UID、peer、原生消息身份、单文件 UUID、名称、大小及 `sendStatus=2`。各自诊断窗口仅有一条精确关联的 `onRichMediaUploadComplete`，`fileErrCode`、`fileSrvErrCode` 均为 0；本地源文件已删除，健康和既有映射保持。这是发送端样本通过，尚未覆盖接收账号入站、URL 或下载；诊断没有改变成功判据，也不证明此前失败的根因已修复。历史 r3 两账号的 `sendStatus=0`、`transferStatus=5` 失败记录、null 的 `sendStatusExtInfo` 和未取得关联错误码的事实继续保留，状态数值语义仍未证实。

privatefile-r5 两账号各一次 60 字节 TXT 和 852 字节 PNG，4 次上传、4 次 `get_msg` 及 4 次独立 native `getMessage` 均成功，精确核对身份、peer、消息与文件定位及 `sendStatus=2`；4 次 `get_private_file_url` 均已调用并返回 retcode 1500。受控云日志分别记为 `nativePrivateFileUrl / INVALID_RESPONSE`，这只是失败阶段线索；下载函数未进入，下载 0 次，无下载字节/SHA256 成功证明，整体验收失败。四个源文件均已清理，两账号健康及原映射保持。结果不证明接收账号入站、旧失败根因已修复或传输状态数值语义。

r5 的版本出处核对区分实际云端 helper `8c9028150125…` 与最终本地 helper `d1d572673a3e…`；仅差部分写盘失败时的临时文件清理，未改发送、URL 或下载逻辑。云端离线 29/29 属于执行版；最终版 `d1d572673a3e…` 后由 URL-r1 Linux 离线 55/55覆盖其中的 r5 全部 29 项，URL-r1 业务报告也记录该依赖哈希。旧 29 项日志仍只属于原执行版，不改写其版本出处。旧 r5 出处依据取回的执行文件核对，旧 TAP 与旧业务报告自身未嵌入源码哈希。

pokerecall-r1 用完既定 8 次写入预算：4 次 poke、2 次新消息发送和 2 次撤回，无重试。`group_poke` 与 `send_poke` 群聊样本各通过一次；`friend_poke` 与 `send_poke` 私聊样本各仅取得 API retcode 0，15 秒窗口内未见匹配 native 通知，双方受控适配器日志均见 `notice_skipped / identity_mapping / INVALID_REQUEST`，具体原因仍未证实。本任务新发的私聊、群消息各完成发送者独立 status 2、接收者精确回读及撤回后的双端通知、精确 native revoke 占位和正 `recallTime`，两次撤回通过。`mark_private_msg_as_read`、`mark_group_msg_as_read`、`mark_msg_as_read` 因没有暴露可核对的对端未读状态而未执行；ACK 不代替状态证明。该批为独立 API 验收，不是 AstrBot 防撤回插件验证。

后续只读 shape 诊断中，两账号当前保留的 event 均为 0，初始存在保留缺口；各账号的精确私聊历史在原观察时间窗内找到 2 条结构化 poke，发起者和目标均匹配批准的双方，`peerUinState=validOther`、类型为 string。该结果只证明历史记录存在，不能补作实时通知通过，也不能证实零 `peerUin` 为原失败根因。

后续实时私聊 shape 专项只新增一次 `friend_poke`：双端均在先安装的独立 event 游标后收到当前会话、精确双方 UID、peer UID、原生 ID 与时间匹配的灰条，`peerUin` 为精确字符串 `"0"`；四次显式 resolve 均匹配批准账号。该字段会触发旧正 UIN 校验拒绝，因此 r8 仅将私聊的字符串 `"0"` 纳入原有缺省值处理，保留结构化双方、peer、会话、时间和正 UIN 冲突检查；数值 0、null、false 及其他畸形值仍拒绝，群聊不采用这一约定。该专项是触发条件诊断，`rootCauseProven=false`，不把旧 pokerecall-r1 改写为成功，也不追认旧批次的具体失败原因。

新的私聊 poke-r2 隔离 WebSocket 验收完成固定两次写入、无重试：legacy 的 `friend_poke` 与 secondary 的 `send_poke` 两个方向均通过。每个方向的两个账号均独立取得当前会话、精确双方及 peer、有效非历史原生 ID 的 native 通知，以及实际收到的 OneBot `notify/poke` WebSocket 帧；身份与秒级时间精确相等，四组 `peerUin` 均为字符串 `"0"`，未分配消息 ID。170 项源码及工具冻结匹配，原 17700/17701 两条路由前后保持，`nodeMutations=0`、`accountRestarts=0`、`scratchRemoved=true`。证据范围严格为 `transportScope:same-artifact-isolated-stack`、`existingDeploymentTransportObserved:false`：验证了同运行源码的隔离 Event 栈，未旁听既有 worker WebSocket 或 AstrBot 连接，也未复测插件；日志不替代实际 WebSocket 帧。该隔离报告不纳入公开部署传输 coverage，旧 pokerecall-r1 的两个私聊失败继续保留。

URL-r1另建的 secondary 单个 TXT 已有真实回执、持久 locator 与发送端独立 native `sendStatus=2`，但正式 OIDB URL 返回 `OIDB_RESOURCE_MISMATCH`，独立经典 Offline 查询返回 `OFFLINE_COMMAND_MISMATCH`，均未完成下载。持久 payload 核对确认原文件大小、SHA256 及原生 MD5 精确一致；URL-r2在新会话再次独立核对同一消息、元素、UUID、hash、名称、大小、自身和 peer 后，仅做一次安全元数据诊断。唯一失败项为 `HASH_ALIAS_NOT_MATCHED`：field 6 精确等于输入 UUID，field 100 是精确匹配输入 MD5 的 16 字节 checksum，field 144 缺失，field 140 是另一不透明值。r2 没有重调正式 URL，也没有下载或新发消息，`businessSuccess=false`。

r9 对上述精确资源形状补充 `directChecksumMatches`：必须同时满足返回 UUID 等于原 UUID、输入是 32 位十六进制 MD5、16 字节 checksum 精确相等，才可通过直接 checksum 路径；原别名和 original-checksum 守卫保持，不能只凭 MD5 认资源。安全诊断升级为 version 2，旧 version 1 消费者必须拒绝新版。r8 的1791/1791 Linux 全量及部署保留检查继续保留；r8 同时将镜像源码目录和文件规范为 0755/0644，并保留必要执行位，不修改账号数据、私有运行目录或依赖目录权限。r9 已通过上述全量和运行镜像验证；

新的URL-r3 正式 URL 与完整下载验收仅复用上述 secondary 原 r1 TXT：在与 r1/r2 不同的新会话中，先做一次独立 native `getMessage`，精确核对原消息、元素、UUID、MD5、名称、大小、自身、peer 与 `sendStatus=2`，再实际调用一次 `get_private_file_url`，返回 retcode 0。只进行一次下载，使用生产 URL 校验器、禁止重定向，完整 **59 字节**与原私有 payload 逐字节及 SHA256 一致；完整流、大小、原 payload SHA/MD5 和持久 locator 均通过。前后 r1/r2 十份 JSON 及 payload 校验保持，旧报告不修改，原消息映射和账号健康保持，新发消息、Offline、raw packet、历史调用均为 0。独立验收工具的隔离 Linux 测试通过 Node 25 项、launcher mock 3 项及 QA 契约 mock 2 项，20 个冻结文件哈希匹配；这些离线项不计为 QQ 正向业务。此结果只证明 secondary 这一个既存 TXT 在 r9 的正式 URL/完整下载路径通过，不代表 legacy、PNG、r5 四个旧失败资源、任意文件、仅 file_id 参数变体或经典 Offline 通过；`receiverAccountVerified=false`，该轮未验证接收端入站；后续固定三条接收记录的 r8rx 证据另见下文。

readonly-r9c 历史能力快照仅做双账号各一次 `get_capabilities`，2/2 通过，0 写入、0 RPC、无转发或插件重测。两账号实际均为 210 个实现名称，明确关闭 `create_flash_task`、`get_ai_record`、`send_group_ai_record`、`send_tuwen_ark` 四项；`upload_forward_msg`、`upload_foward_msg` 以及 `send_forward_msg` 的 targeted/upload-only 两个变体实际均可用。此前局部 capability 摘要缺少显式启用字段，不能据此推断 QQ 又关闭了上传；该完整快照结合原 r6 完整资源回读证据，确认两别名及 upload-only 变体解除历史门控，没有新增上传或发送。

历史 r2 台账快照：r2历史台账及结构化台账记录参考名称实现 **200/200**、合并历史后 **122 个名称在已记录范围内最新云验通过**。全部已完成 wave5 历史及重测共 **541 次动作场景：489 通过、52 失败**；489 中有 465 个正向场景和 24 个预期拒绝，另有 99 条明确未执行及 6 个零动作初始化失败。这些数不是 541 个独立接口，也不是 200 项或全部参数业务通过；空页、ACK 和本地工具只按各自记录范围计，正向与拒绝边界按账号分别取最新批次，所有历史失败和跳过保留。私聊 poke-r2 隔离 Event 栈报告单列，不纳入该公开部署传输台账。r1历史台账及原结构化台账保持原样；历史 r9 健康快照及后续 r9c 只描述各自时点。用户已停止的插件专项没有恢复。

### r13 当前部署与私聊文件参数验收

正式r13 兼容修复与云验汇总及结构化汇总已生成。最新r3 覆盖台账及结构化台账共 **559 次动作场景：507 通过（477 正向＋30 预期拒绝）、52 历史失败**，另有 **99 条跳过、6 个零动作初始化失败**；r2 的 541 次记录保持为历史快照。

当前 r13-r1 部署已通过 Linux 全量 **1883/1883**；native 验证及实际运行镜像校验通过，**176 个运行文件、8 个 WebUI 文件**及修订源码一致。最终健康快照与部署记录确认两账号身份、私有配置/权限、旧消息映射及 AstrBot 配置、容器、原插件代码保持；**legacy→17700、secondary→17701** 两条路由继续连接。

`get_private_file_url` 的 `file_id` 路径只扫描本账号 retained 的完整 records，不扫描任意历史或其他账号。`message_id` 路径仍可利用已保存的原始 locator 刷新被裁剪的 record，失效或不匹配的 locator 不恢复为成功。可选 `user_id` 经真实身份解析后限制私聊 peer；`file_hash` 省略或空字符串不增加过滤，非空 opaque 值必须精确匹配原记录，不能替代真实 hash。候选歧义、不完整或失效时拒绝；刷新后及 native 请求前再次绑定当前账号/会话、peer、消息定位、element、UUID 与 hash，不自动回退 classic Offline。

r9fid 真实生产验收只复用原 r7/r8rx 三条既有接收资源。每条分别验证 `message_id+file_id+真实 user_id+原 hash`、`file_id`、`file_id+user_id+hash`、`file_id+file_hash:''`，共 **12 个正向结果**；另以本号作为错误 peer、以错误非空 hash 分别走 `file_id` 路径，共 **6 个精确 retcode 1404 拒绝**。前两种成功变体各完整下载一次，共 **6 次**，三份原 payload 的 **60、852、852 字节各核验两次**，完整流、逐字节及 SHA256 均匹配；后两种只验证生产 URL 形状。总计 **18 次公开 URL action、2 次独立 RPC status、0 业务写入、0 history、0 验收工具 direct native 读取**；旧证据封存哈希保持，历史 epoch 只与旧证据互验，当前会话另行绑定。外部守卫确认容器、StartedAt、镜像、配置、两条路由与旧映射保持。该结果不外推 r5 四个旧失败资源、任意文件/账号/格式、classic Offline、完整入站导出或 AstrBot/plugin 传输。

普通 `_send_group_notice` 的固定默认值已对齐 `confirm_required=1`，本地出站表单契约通过并随 r13 部署；高级参数和图片仍未开放。本轮没有云端公告写入，也没有成员确认或已读的云端验收。此节新证据与r2 历史台账计数分别记录。

### r12 历史部署与后续限定证据

当时成功部署为 r12-r1：云端 Linux 全量 1805/1805，fail/cancelled/skipped/todo 均为 0；native 验证、构建镜像校验及实际运行镜像校验通过，176 个运行文件、修订源码、native source/addon 和 8 个 WebUI 文件一致。部署报告分别核实双账号新鲜 ready/online/authorized、身份与会话、原账号私有目录、旧消息映射、私有配置及权限，并确认 AstrBot 配置、容器和原插件代码保持。两条既有路由继续保留并连接：**legacy→17700、secondary→17701**。构建和部署证明与下列限定业务验收分别记录。

历史 r10 r2 部署失败及当时回退健康未确认的记录保留；其后恢复健康检查、r10 r3 成功部署和运行镜像校验分别说明后续结果。r11 的 1801/1801为构建历史，未单独部署；相册及闪传修复合入 r12 后一次部署，未以构建成功代替运行成功。

### 三条私聊接收记录

privatefile-r7固定三份新文件：legacy→secondary 的 TXT、PNG，以及 secondary→legacy 的 PNG。发送端独立 native `status2` 与完整流、逐字节及 SHA256 下载均为 **3/3**；接收端实时事件和 payload MD5 为 **3/3**，但原独立 native 全字段比较为 **0/3**。原接收端失败保持，不能用发送端成功或整份报告标志改写。

后续只读绑定诊断确认仅 `sourceType` 不同：独立 native 查询为数值 0，其余 16 项绑定完全相等；诊断不计业务成功。新的 r8rx 接收端验收只复用这三条既有接收记录，在实际收件账号分别调用 `get_msg` 和 `get_private_file_url`，公开读取 **6/6**；完整下载 **3/3**，大小为 **60、852、852 字节**，完整流、逐字节及 SHA256 均匹配。仅独立查询的 `sourceType` 严格接受数值 0，其余身份、消息、时间、UUID、名称、大小与摘要仍精确绑定；使用生产 URL 校验器且禁止重定向。

r8rx 无新发送、direct native 或 history 调用；外部守卫独立确认容器、StartedAt、镜像、原配置、两路由及既有映射保持。核心报告未重复列出 `mappingPreserved` 不代表映射丢失。该证明仅覆盖三条接收记录，不外推 r5 四个失败资源、任意文件/格式、仅 `file_id` 请求、classic Offline、完整入站事件导出或 AstrBot/plugin 传输；原 r7 接收端 **0/3**、r5 URL 失败和 secondary 单个 59 字节 TXT 的 URL-r3 成功分别保留。

### 闪传与相册读取

readonly-r11q对实际缓存群卡完成双账号 `get_fileset_id`、`get_fileset_info`、`get_flash_file_list`、`get_share_link` 共 **8/8**，仅一条精确文件元数据和原官方分享链接，`completeInventory=false`。同批两个 `download_fileset` 为真实失败、两个 URL 别名跳过，整批仍为 **8 通过/2 失败/2 跳过**。r12 仅规范化已观察 rkey token 的单个前导 `&`，原 URL/身份校验保留；r13q双账号 `download_fileset` 与 `get_flash_file_url` **4/4**，核对同一主文件 ID/名称/大小及账号会话，取得 scoped 官方 URL。历史元数据 epoch 与当前会话分别绑定，未要求跨登录相等；没有下载内容字节或内容 SHA 证明。

相册 r9q是公开 `id` 被误按 native `albumId` 校验的脚本失败；r10q媒体双号 retcode 1500 为真实产品 bool 解码错误。r12 按 protobuf 非零为 true 修复，保留原 wire/数值/重复/资源检查；r12q双号目录与媒体共 **4/4**，唯一 `test` 相册各返回 **5 条首屏元数据**且 `continuationPresent=true`，未验证完整分页或照片下载。相册与闪传的外部守卫分别见 r12q、r13q；新增的是七个名称的限定样本读取证据，文件集详情/别名不构成额外独立业务能力，原失败、跳过及旧样本删除记录均保留，无新增业务写入。

新增 r14q沿实际新游标续页，8 次读取为 **6 通过、2 失败**：两号媒体均为 5→0→重复首屏，未形成完整分页。四项外部保留检查通过，整轮验收与 guard 仍为失败，原记录保留。依据已保存响应诊断，r15 仅对空续页中已观测的精确全零 JSON 重置游标返回空 `nextAttachInfo`，未知/近似游标不猜结束；相册目标 49/49 为离线验证，新云验须另记。r3 的 122 是冻结历史台账的限定范围，不将本轮分页失败改写成成功；名称最新状态须以随后纳入新批次的台账为准。

用户样本验收索引集中列出七个读取名称和双账号 14 份成功证据；详细协议边界见[闪传扩展](flash-transfer-extensions.md)。这些名称不代表额外独立业务能力。

### 已修契约与未完成兼容

对 22 个既有写接口的源码契约审计及相关本地回归 **98/98** 已完成，修复已随 r12 部署：`set_online_status` 缺省 `battery_status=100`、拒绝 `status=0`；`set_group_add_request` 支持 `type/sub_type`、缺省 add 并拒绝冲突；`card`、`duration`、`special_title` 仅 undefined 使用原默认，显式 null 在写入前拒绝，`duration=0` 解禁保持。真实账号/会话、一次性 flag、匹配确认和超时不重试语义保持。这些本地项不计为 QQ 正向云验，也不扩大资料、成员、群设置、收藏等写入范围。

当前私聊文件选择契约及公告默认值已由上方 r13 段落更新。r14 源码补充了 `friend_poke.target_id` 与 `set_qq_profile.sex`：前者独立解析会话对端和目标，省略目标时沿用对端；私聊通知独立核对真实 peer，支持自己戳自己和对端戳对端，仍拒绝第三人通知。后者接受整数 0/1/2，经固定 `0x112a/2` 的 `20009` 字段写入本号，ACK 后必须真实回读 `baseInfo.sex` 匹配；多字段修改先完整校验，失败不重试或回滚。定向与邻近 poke 测试分别 54/54、102/102，资料和原生通道目标 58/58；这些离线结果不代表新增正向云验，未执行真实资料写入。

当前运行 r15 的个人/群头像仍仅接受本账号 opaque image handle；r16 源码正在补齐受限 local/URL/base64 导入，规则见[头像输入](avatar-input.md)，尚未部署或云改头像。资料无字段 no-op、空昵称和 `send_like` 显式 0 亦属于 r16 源码补充。仍有明确兼容边界：头像只接受 PNG/JPEG/GIF，本地路径限本号媒体目录；资料严格字符串和容量限制保留；公告高级字段与图片未实现，普通公告默认 `confirm_required=1` 没有云公告写入；`send_like` 大于 10 未对齐；空群名仍拒绝。mark-read 缺可靠对端未读语义和查询关联，不能靠 ACK 补成功；两测试账号收藏均为空，只证明空页。生产 r15 的四个整项 `create_flash_task`、`get_ai_record`、`send_group_ai_record`、`send_tuwen_ark` 继续门控；待部署 r18 源码仅解除创建版本门控，完整创建尚待云验，名称实现数不能代替这些参数、权限与业务边界的验收。

上述五组参数/默认值差异的 r12 历史源码和 SnowLuma 实际调用链见样本后的契约复核；该复核没有新增云端写入或重跑原 98 项。报告中的 file_id-only 与普通公告默认值是修复前快照，当前以 r13 契约及其分别限定的验证范围为准。

静态契约另确认：`send_poke` 要求正 uint32 `user_id`，省略 `group_id` 为私聊，提供正 `group_id` 为群聊；0、null、空字符串不作为私聊路由。`group_poke` 必须有群号，`friend_poke` 禁止群号，三者接受 `user_id`、适用的 `group_id` 及通用 `self_id`，仅 `friend_poke` 额外接受可选正 uint32 `target_id`。`user_id` 始终指定私聊对端，`target_id` 指定独立目标，两者分别核实真实 UIN/UID；不同账号不得映射成同一 UID。三者的成功响应只证明固定服务 ACK 与目标身份核对，实时通知需另有 native 观察证据；不能由两个群聊样本推导整个 `send_poke` 全变体通过。

group-tempfiles-r1 共 31/31 动作通过：legacy 4 步均只读，secondary 27 步中创建目录、改名、上传、移动、转存、删除文件、删除目录各派发一次。仅操作本任务的随机新目录和 80 字节 TXT；移动后与转存后分别完整下载并逐字节、SHA256 核对。转存定位由新鲜根/指定目录记录及详情共同确认，后续使用实际重新查询的 busid。finally 证明自有文件缺失、目录为空后删除并回读缺失，17 个旧文件身份摘要保持；本地源文件已移除，私有恢复记录已清除，无未知写入。该写入证据仅属于 secondary 的这一临时对象范围，legacy 历史建目录权限拒绝及其他权限/批量变体继续保留。

readonly-r8q 双账号共 4/4 查询通过：已观察的 fileset 部分目录和已有 saved-face 目录均返回空页，fileset 的 `completeInventory=false`。相关下载、详情、分享、闪传发送及自定义表情发送缺少真实 fixture，共 16 条依赖场景明确未执行；空页不证明非空、全目录、发送或修改路径通过。

## 四个验证阶段的剩余工作

1. **QQ 原生能力验证**：逐项在目标版本验证新增图片下载、文件上传、历史、撤回和群操作；管理动作需选择允许修改的测试群并单独授权。登录二维码与发送对象、次数按本次测试授权确认。
2. **OneBot 完整兼容**：未支持动作和媒体保留明确错误；缺少稳定签名、相关 ID、编码或真实下载结果时不扩展能力宣称。需要实际 aiocqhttp/AstrBot 验证新增事件与参数格式。
3. **管理与隔离**：多账号管理、鉴权、资源下载地址与账户生命周期需验证撤权、切号、过期签名和交叉账号访问；进程活着或 WebSocket 连通均不能代替 QQ 已上线。
4. **故障场景和交付**：变更后的版本需要独立完成断线重连、进程重启后 ID 恢复、账号切换隔离、超时不重发和队列溢出检查；每项分别记录模拟测试、目标环境结果或未验证状态。用户已取消两小时观察，本轮不恢复该等待要求。源码包、Docker 构建和真实云端镜像验证也分别列出，未执行的项目不记为已交付。

完整可用性仍取决于当前账号 QQ 是否完成初始化。下载及发送没有确认时返回超时，可能已执行的发送不自动重试；队列溢出和断线缺口只记录诊断，不承诺完整补发。

私有 `build`、`inspectBuild` 和 `nativeMergeProbe` 仍是受限诊断入口，没有开放为任意 OneBot action，也不授予任意原生消息元素的发送权限。已有消息合并的固定 `existingMerge` 内部契约及 `node.data.id` 转换保留，但目标 QQ 的 `mergeExistingNative` 为 false，正式 RPC 也在查询或写派发前拒绝，不能直接绕过 OneBot 能力门控。两账号的实际送达及完整内容已回读核对；新增实时诊断进一步证明 native 已返回数值0，但早期和最终回调均没有请求 correlation。不能将该样本的问题归因于未结算 Promise，也不能按时间、作者或文本猜测目标 ID。后续需取得真实原生关联契约才能启用。原实验超时元组不可重试。

### AstrBot 合并发送

两个合并发送 action 共用正式分发、账号授权和 60 秒媒体期限。本账号作者且省略 time 的原路径先暂存全新源消息，再确认完整目标资源；不同作者或显式 time 的路径逐个作者解析真实 UID，保留昵称及正数时间，零时间使用 QQ 服务端时间，图片正文来自已核验的原生暂存资源。r6 的双账号群/私聊、文字/PNG metadata 样本已完成发送端和接收端公开查询。已有 ID 节点仍在派发前关闭，不能按内容或时间猜测目标 ID。所有步骤共用剩余期限，未知结果不重发；图片暂存保留于官方 QQ 自聊历史，失败可能已产生部分资源或消息。未知段整条拒绝，完整 Ark 合并根可登记句柄，普通 Ark 仍按 JSON 处理。

自定义节点接受 `nickname` / `name` 和 `user_id` / `uin` 别名，冲突时整批拒绝；time 必须为精确 uint32 秒值。仅在成功识别并严格验证 9/4 时，查询优先保留原始资源中的作者、名称、时间及元素；一旦出现 9/4 候选，未知或畸形内容整条失败。识别前临时不可用或 1500ms 到期则沿用 QQ 实际 native 元数据，不保证自定义昵称；原生 9/175 保留 1000 节点、8 MiB、富元素和已观察的嵌套节点。服务端已证头部变化不会放松完整 MessageBody 校验。

metadata-r4 的图片失败、r5 发送端通过但接收端失败、原 r6rx 的两项时间断言失败均保留，详见 [转发扩展](forward-extra.md)。r6rx2 以接收端独立 native 根精确核对根时间，不要求不同账号根时间相同；节点时间没有放宽。原版插件方法捕获 r1/r2 分别因 live mount 布局和 Docker 环境检查停止，均无 payload、无 QQ 调用。2026-11-16 用户反馈防撤回实际使用正常并要求停止独立验证；按用户反馈记录，不作为自动化 live 流程通过，不再继续插件捕获或转发重验。

## 本轮新增的固定入口

新增 `get_record` 及公告、精华、表态、好友分组、头像、在线状态、OCR、AI 声音目录和系统表情目录等正式入口。全部复用账号授权、期限、完整参数校验及严格回执；实际可用性看本账号 `get_capabilities`。源码已实现或服务 ACK 不等于所有权限和参数变体均已真机通过，完整参数范围与云测结果见本轮交付报告。

`record/video/file` 新增 canonical base64 输入，单消息全部内联媒体解码总量最多 10 MiB，先整批验证再进入账号私有暂存；成功、失败或超时均清理暂存。任意 URL/宿主文件输入仍拒绝。`get_record` 返回本地格式导出路径，不能把容器内路径当作跨容器下载 URL。

能力目录为 `send_group_forward_msg` 分别列出 `variants.custom_text_image_nodes` 和 `variants.existing_message_id_nodes`；当前目标 QQ 的后者固定为 false。保留的 `existing_scope: same-source-group-plain-text-1..20` 描述实验实现范围，不代表启用。顶层 `available` 可由自定义文字/图片节点独立满足，调用前仍须查看所需变体；私聊 action 只有自定义节点变体。目录方法存在性、离线测试和对应账号的真实业务验收继续分开记录。

## 后续剩余入口补充索引

上一轮剩余入口的后续实现、当前门控及验证证据统一见 [后续完善记录](qqapi-remaining-20261116.md)。分项契约见 [鉴权与数据库](auth-extra.md)、[原始 SSO 与统计](raw-packet.md)、[生命周期与缓存](lifecycle-actions.md)、[分词](word-slices.md)、[型号展示](model-show.md)、[URL 安全](url-safety.md)、[收藏创建](collection-create.md)、[群匿名操作](anonymous-actions.md) 及 [完整表情回应汇总](emoji-summary.md)。上一轮 [扩展验证记录](qqapi-expansion-20261116.md) 已归档，其中计数和未支持列表只描述对应历史快照，不代替当前能力目录。
