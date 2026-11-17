# QQAPI 扩展与真实验证范围

公开验证概要见 [0.2.0-alpha.3 发布说明](releases/0.2.0-alpha.3.md)；内部执行记录不随源码发布。

> 本文保留 wave4r5 历史证据，并在下方补充 wave5 当前态。“wave4r5 历史验证与计数”至文末均为当轮快照，其中的旧计数、门控与凭据/原始 SSO/生命周期限制不代表当前源码。后续实现详见 [后续完善记录](qqapi-remaining-20261116.md)，实际可用性以当前账号 `get_capabilities` 为准。

参考清单来自用户提供的 20 张 SnowLuma 示例截图，共 200 个不同 action 名称。源码参照 SnowLuma 2.4.2，提交 `5dcbfa6f297b9dd112d859c2793687f8ed4bf563`。名称覆盖只表示存在同名实现入口，具体参数兼容与实际业务需分别核对；别名、空页、离线样本和参数拒绝不计为新的独立 QQ 业务能力。

## wave5 当前态补充

当前目录注册 210 个 action 名称，200 个参考名称均有源码实现；这不是 200 项真实 QQ 业务全部通过。当前生产 r15 的目标 QQ `3.2.35-54395` 仍有四个版本门控动作：`get_ai_record`、`send_group_ai_record`、`create_flash_task`、`send_tuwen_ark`。待部署 r18 源码仅解除闪传创建的版本硬门控，阶段 ACK 与主文件 appid 修复已通过定向离线测试和参考字节对照；完整创建尚待真实云验。两个转发上传别名及 `send_forward_msg` 无目标分支已恢复，在双账号共 6/6 完成严格语义回读。9/4 校验只允许已真实观察的头部变化，完整 MessageBody 字节及节点顺序、作者、名称、时间等内容保持不变。

自定义节点支持真实作者解析、`name`/`uin` 别名和显式 time，零时间取 QQ 服务端时间。r6 双账号群/私聊、文字/PNG 样本的 metadata 发送端 24/24 与 接收端 r6rx2 公开查询 16/16、独立 native 根检查 8/8 均通过。根绑定后只有成功识别并严格验证 9/4 才优先使用原始 `resourceNodes`；任一候选的未知或畸形内容整条失败。识别前临时不可用或超出共享 1500ms 探测预算时沿用 native 及其实际元数据，原生 9/175 的 1000 节点、8 MiB、富元素和嵌套读取保留。详细契约见 [转发扩展](forward-extra.md)。

r6 转发业务回归为 上传 6/6、消息 38/38 和 兼容性 12/12，其中兼容性 8 项为预期拒绝，不是新的正向业务。历史 r9 云端 Linux 全量 1793/1793、0 失败、0 跳过；native 验证、176 项运行源码哈希及权限与部署保留检查均通过，两个账号的原目录、旧消息映射、17700/17701 分流路由及 AstrBot 配置、容器和插件代码保持。此前 r7 首轮 1773 项中 1767 通过、6 失败，原因是新增 observer fixture 目录默认 0755；r7a 将测试目录改为 0700 并增加 POSIX 权限断言，保留原生产私有目录检查。r7 失败及 r6 1766/1766 的历史均保留。

privatefile-r4 双账号各一次 60 字节 TXT 发送及 `get_msg` 共 4/4 通过，另各一次独立 native 回读精确匹配发送者、peer、消息身份、文件 UUID/名称/大小与 `sendStatus=2`；各有一条精确关联的上传完成诊断，`fileErrCode`、`fileSrvErrCode` 均为 0。本地源文件已清理，健康和既有映射保持。结果限于发送端样本，不代表接收账号入站、私聊 URL 或下载通过，也未证明此前失败根因已修复。

privatefile-r5 两账号各一次 60 字节 TXT 与 852 字节 PNG，4 次上传、4 次 `get_msg`、4 次独立 native 精确回读均成功且 `sendStatus=2`；4 次 `get_private_file_url` 实际调用均 retcode 1500，受控云日志阶段为 `nativePrivateFileUrl / INVALID_RESPONSE`。下载函数未进入，下载 0 次、无下载字节/SHA256 证明，整体验收失败；源文件已清理，健康和旧映射保持。该失败阶段尚不足以确认根因，也没有接收账号入站证明。r5 版本出处确认实际云 helper `8c9028150125…` 与最终本地 `d1d572673a3e…` 仅差部分写失败时的文件清理；Linux 离线 29/29 属于执行版，最终版 `d1d572673a3e…` 后由 URL-r1 Linux 离线 55/55覆盖其中的 r5 全部 29 项，业务报告记录该依赖哈希；旧 29 项日志的原执行版出处保持。

pokerecall-r1 已用完 4 poke、2 send、2 recall 共 8 次写入预算，无重试。`group_poke`、`send_poke` 群聊各一次通过 API 及匹配 native 通知；`friend_poke`、`send_poke` 私聊各一次虽 API retcode 0，15 秒内未见匹配 native 通知，双端受控日志均见 `notice_skipped / identity_mapping / INVALID_REQUEST`，具体原因未证。两条本任务新发的私聊/群消息均有发送者独立 status 2 和接收者精确回读，撤回后各有双端通知、精确 native revoke 占位及正 `recallTime`，两次撤回通过。这是独立 API 验收，不是 AstrBot 防撤回插件验证；三个 mark-as-read action 因缺少可暴露的对端未读状态而未执行。

后续只读 shape 诊断的当前 event 两账号均为 0 且有保留缺口；各账号精确私聊历史在原时间窗内各找到 2 条结构化 poke，双方身份匹配，`peerUinState=validOther` 且为 string。只证明历史存在，不能补作实时通知成功或证实零 `peerUin` 根因。

后续实时私聊 shape 专项只新增一次 `friend_poke`：双端均在先安装的独立 event 游标后收到当前会话、精确双方 UID、peer UID、原生 ID 与时间匹配的灰条，`peerUin` 为精确字符串 `"0"`；四次显式 resolve 均匹配批准账号。该字段会触发旧正 UIN 校验拒绝，因此 r8 仅将私聊的字符串 `"0"` 纳入原有缺省值处理，保留结构化双方、peer、会话、时间和正 UIN 冲突检查；数值 0、null、false 及其他畸形值仍拒绝，群聊不采用这一约定。该专项是触发条件诊断，`rootCauseProven=false`，不把旧 pokerecall-r1 改写为成功，也不追认旧批次的具体失败原因。

新的私聊 poke-r2 隔离 WebSocket 验收完成固定两次写入、无重试：legacy 的 `friend_poke` 与 secondary 的 `send_poke` 两个方向均通过。每个方向的两个账号均独立取得当前会话、精确双方及 peer、有效非历史原生 ID 的 native 通知，以及实际收到的 OneBot `notify/poke` WebSocket 帧；身份与秒级时间精确相等，四组 `peerUin` 均为字符串 `"0"`，未分配消息 ID。170 项源码及工具冻结匹配，原 17700/17701 两条路由前后保持，`nodeMutations=0`、`accountRestarts=0`、`scratchRemoved=true`。证据范围严格为 `transportScope:same-artifact-isolated-stack`、`existingDeploymentTransportObserved:false`：验证了同运行源码的隔离 Event 栈，未旁听既有 worker WebSocket 或 AstrBot 连接，也未复测插件；日志不替代实际 WebSocket 帧。该隔离报告不纳入公开部署传输 coverage，旧 pokerecall-r1 的两个私聊失败继续保留。

URL-r1另建的 secondary 单个 TXT 已有真实回执、持久 locator 与发送端独立 native `sendStatus=2`，但正式 OIDB URL 返回 `OIDB_RESOURCE_MISMATCH`，独立经典 Offline 查询返回 `OFFLINE_COMMAND_MISMATCH`，均未完成下载。持久 payload 核对确认原文件大小、SHA256 及原生 MD5 精确一致；URL-r2在新会话再次独立核对同一消息、元素、UUID、hash、名称、大小、自身和 peer 后，仅做一次安全元数据诊断。唯一失败项为 `HASH_ALIAS_NOT_MATCHED`：field 6 精确等于输入 UUID，field 100 是精确匹配输入 MD5 的 16 字节 checksum，field 144 缺失，field 140 是另一不透明值。r2 没有重调正式 URL，也没有下载或新发消息，`businessSuccess=false`。

r9 对上述精确资源形状补充 `directChecksumMatches`：必须同时满足返回 UUID 等于原 UUID、输入是 32 位十六进制 MD5、16 字节 checksum 精确相等，才可通过直接 checksum 路径；原别名和 original-checksum 守卫保持，不能只凭 MD5 认资源。安全诊断升级为 version 2，旧 version 1 消费者必须拒绝新版。r8 的1791/1791 Linux 全量及部署保留检查继续保留；r8 同时将镜像源码目录和文件规范为 0755/0644，并保留必要执行位，不修改账号数据、私有运行目录或依赖目录权限。r9 已通过上述全量和运行镜像验证；

新的URL-r3 正式 URL 与完整下载验收仅复用上述 secondary 原 r1 TXT：在与 r1/r2 不同的新会话中，先做一次独立 native `getMessage`，精确核对原消息、元素、UUID、MD5、名称、大小、自身、peer 与 `sendStatus=2`，再实际调用一次 `get_private_file_url`，返回 retcode 0。只进行一次下载，使用生产 URL 校验器、禁止重定向，完整 **59 字节**与原私有 payload 逐字节及 SHA256 一致；完整流、大小、原 payload SHA/MD5 和持久 locator 均通过。前后 r1/r2 十份 JSON 及 payload 校验保持，旧报告不修改，原消息映射和账号健康保持，新发消息、Offline、raw packet、历史调用均为 0。独立验收工具的隔离 Linux 测试通过 Node 25 项、launcher mock 3 项及 QA 契约 mock 2 项，20 个冻结文件哈希匹配；这些离线项不计为 QQ 正向业务。此结果只证明 secondary 这一个既存 TXT 在 r9 的正式 URL/完整下载路径通过，不代表 legacy、PNG、r5 四个旧失败资源、任意文件、仅 file_id 参数变体或经典 Offline 通过；`receiverAccountVerified=false`，该轮未验证接收端入站；后续固定三条接收记录的 r8rx 证据另见下文。

readonly-r9c 历史能力快照仅做双账号各一次 `get_capabilities`，2/2 通过，0 写入、0 RPC、无转发或插件重测。两账号实际均为 210 个实现名称，明确关闭 `create_flash_task`、`get_ai_record`、`send_group_ai_record`、`send_tuwen_ark` 四项；`upload_forward_msg`、`upload_foward_msg` 以及 `send_forward_msg` 的 targeted/upload-only 两个变体实际均可用。此前局部 capability 摘要缺少显式启用字段，不能据此推断 QQ 又关闭了上传；该完整快照结合原 r6 完整资源回读证据，确认两别名及 upload-only 变体解除历史门控，没有新增上传或发送。

历史 r2 台账快照：r2历史台账及结构化台账记录参考名称实现 **200/200**、合并历史后 **122 个名称在已记录范围内最新云验通过**。全部已完成 wave5 历史及重测共 **541 次动作场景：489 通过、52 失败**；489 中有 465 个正向场景和 24 个预期拒绝，另有 99 条明确未执行及 6 个零动作初始化失败。这些数不是 541 个独立接口，也不是 200 项或全部参数业务通过；空页、ACK 和本地工具只按各自记录范围计，正向与拒绝边界按账号分别取最新批次，所有历史失败和跳过保留。私聊 poke-r2 隔离 Event 栈报告单列，不纳入该公开部署传输台账。r1历史台账及原结构化台账保持原样；历史 r9 健康快照及后续 r9c 只描述各自时点。用户已停止的插件专项没有恢复。

### r13 当前部署与文件参数验收

正式r13 兼容修复与云验汇总与最新r3 覆盖台账已生成；r2 台账与计数继续保留为历史快照。

当前 r13-r1 部署确认 Linux 全量 **1883/1883**；native 验证和运行镜像校验通过，**176 个运行文件、8 个 WebUI 文件**一致。原身份、私有配置/权限、旧映射及 AstrBot 配置、容器、插件代码保持，**legacy→17700、secondary→17701** 继续连接。

`get_private_file_url` 新增仅 `file_id` 的本账号 retained 完整 records 查找；已有 `message_id` 可按仍有效 locator 刷新已裁剪 record。可选 `user_id` 严格限制真实 peer；hash 省略或 `''` 不增加过滤，非空 opaque hash 精确匹配；歧义、不完整或失效时拒绝，刷新后在 native 请求前重新绑定账号/会话、peer、消息、element、UUID 与真实 hash，不自动回退 classic Offline。r9fid 云验仅复用原三条接收资源：每条 `message_id+file_id+真实 user_id+原 hash`、仅 `file_id`、`file_id+user_id+hash`、`file_id+file_hash:''` 四种成功变体，共 **12 个正向结果**，另有错误 peer/hash 的 **6 个精确 1404 拒绝**。前两变体共 **6 次完整下载**，**60、852、852 字节各两次**与原 payload 逐字节及 SHA256 相等；后两变体只验证 URL 形状。总计 **18 次公开 action、2 次 RPC status、0 写入/history/验收工具 direct native 读取**，外部守卫确认容器、镜像、配置、双路由、旧映射与封存证据保持。结果不外推 r5 旧失败、任意文件/账号/格式、classic Offline、完整入站导出或 AstrBot/plugin。

普通公告默认 `confirm_required=1` 已通过本地出站契约验证并随 r13 部署；高级参数与图片未开放，没有云公告写入、成员确认或已读验收。详细当前边界见[能力边界](capability-limits.md)与[查询扩展](query-extensions.md)；r2 计数及 r12 记录继续作为历史保留。

### r12 历史部署与后续限定证据

当时 r12-r1 部署、native 验证和运行镜像校验均通过；Linux 1805/1805，fail/cancelled/skipped/todo 均为 0，176 个运行文件、修订源码、native source/addon 与 8 个 WebUI 文件一致。双账号新鲜 ready/online/authorized、原私有目录/配置/权限、旧映射及 AstrBot 配置、容器、原插件代码保持；两条既有路由继续连接：**legacy→17700、secondary→17701**。历史部署失败、恢复及独立业务范围见[能力边界](capability-limits.md)。

privatefile-r7的固定三文件发送端 native status2/完整字节与 SHA256 下载为 **3/3**，接收端 live 事件/payload MD5 为 **3/3**，原 native 全字段比较仍为 **0/3**。只读诊断仅证明查询 `sourceType=0` 与原事件不同，其余 16 项绑定相等，不计业务通过。后续 r8rx复用同三条记录，在实际收件账号公开查询 **6/6**、完整流/逐字节/SHA256 下载 **3/3**（60、852、852 字节）；严格接受查询数值 `sourceType=0`，其余身份、消息、时间及文件绑定不放宽。无新发送、direct native 或 history 调用，外部守卫独立证明运行容器、配置、旧映射及双路由保持。原 r7 接收端 0/3 保留，不能外推 r5 旧四资源、任意文件、file_id-only、classic Offline、完整入站导出或 AstrBot/plugin。

新增的七个读取名称及双账号 **14 份成功证据**统一见用户样本验收索引。其中 r11q补齐四个闪传元数据/分享读取名称的 8/8；原下载链接双号失败和别名双号跳过保留。修复后 r13q两个 URL 名称双号 **4/4**，只证明精确主文件 ID/名称/大小与官方 scoped URL，没有下载内容字节或内容 SHA。r12q相册目录/媒体双号 **4/4**，每账号 **5 条首屏元数据**、`continuationPresent=true`，未验证完整分页或照片下载。相册 bool 非零解码与闪传 rkey 单个前导 `&` 修复保留原 wire、URL、身份及重复校验；r9q 脚本 validator 失败、r10q 产品失败及 r11q URL 失败不改写，无新增业务写入。

既有 22 项契约审计中的默认值/null/群请求修复随 r12 部署，原本地 **98/98** 仍是历史离线证据，未计为 QQ 正向云验。样本后的契约复核记录的是 r12 时私聊 file_id-only、poke 独立 target、头像输入、资料 sex 和公告默认值等差异；其中私聊文件选择与普通公告默认值已由上方 r13 更新。四个整项门控、资料/成员/群设置/收藏等未正向云测边界保持，名称覆盖不等于完整参数兼容。

以下为 r12 静态审计历史（私聊文件选择限制已由上方 r13 更新）：当时 `get_private_file_url` 必须本账号已知 `message_id`、可选 `file_id` 精确筛选，UUID/checksum 从原生消息取值；参考的仅 `file_id`、可选 `user_id`/`file_hash` 请求形状尚不兼容，公共请求也不自动回退 classic Offline。当时 `friend_poke` 的参考可选 `target_id` 被严格参数检查拒绝；r14 源码现已独立解析并核对对端和目标，同时修复私聊双方各自戳自己的通知转换。`set_qq_profile.sex` 现支持整数 0/1/2，固定写入本号并以真实资料回读确认，ACK 不直接算修改成功。poke 定向 54/54、邻近 102/102，资料/原生通道目标 58/58 均为离线验证，未执行资料云写；这些参数补充不增加名称覆盖。`send_poke` 私聊与群聊仍须分别验证，不能由群聊通过推导整个 action 通过。详细参数与证据范围见 [能力边界](capability-limits.md)。

group-tempfiles-r1 legacy 4 步只读、secondary 27 步，共 31/31 通过。secondary 仅对本任务新目录/TXT 各执行一次创建、改名、上传、移动、转存、删文件和删目录；两次完整 80 字节下载均逐字节及 SHA256 匹配。转存返回的 `save_busid` 与新鲜目录实际 busid 不同，后续按精确目录/详情重新查询的实际值执行。finally 完成自有对象清理并回读，17 个旧文件摘要保持，本地源文件和私有恢复记录已清除；legacy 的历史权限拒绝不从 secondary 结果继承成功。

readonly-r8q 双账号共 4/4 通过，范围仅为 fileset 已观察的部分目录及 saved-face 目录空页；fileset `completeInventory=false`。缺少真实 fixture 的依赖读取/发送共 16 条明确跳过，不算非空、完整目录或发送能力通过。历史r2台账已收口。

metadata-r4 的 4 项图片失败、metadata-r5 发送端 24/24 通过但接收端未闭环的历史均保留。原 r6rx 两项失败由 只读诊断 确认为跨账号根时间相差 1 秒：接收端 public/cache/native 完全一致。r6rx2 逐条按接收端独立 native 根精确验证，转发节点 time 没有增加容差；`get_msg` 可读缓存，不代表强制刷新。原版插件方法捕获 r1/r2 因布局与 Docker 环境检查停止，均无 payload、无 QQ 调用。2026-11-16 用户反馈防撤回实际使用正常，要求停止该项独立验证；这是用户实测反馈，不是自动化 live 撤回流程证据，不再继续插件捕获或转发重验。历史r2台账已生成，以下 wave4 的通过数和失败事实均继续作为历史保留。

## wave4r5 历史验证与计数

wave4r5 当时的 200 个参考名称中，182 个具有源码实现，18 个明确不支持。项目完整目录另外保留 9 个参考清单外的既有入口，合计实现 191 项（标准动作 31、扩展入口 160）。当时汇总 13 批真实报告，52 个参考名称在各账号最新记录批次的已测范围通过；这不是全部参数、权限或独立业务能力的覆盖数。另有 75 个既有实现待逐项契约审计、46 个当轮范围未云验、2 个离线待云验、6 个真实验证未通过，以及 1 个部分场景未通过名称。`create_group_file_folder` 保留 legacy 账号权限拒绝与 secondary 成功清理的不同结果，不合并为全通过。

wave4r5 当时在目标 QQ `3.2.35-54395` 关闭 6 个未闭环入口：`get_ai_record`、`send_group_ai_record`、`create_flash_task`、`send_tuwen_ark`、`upload_forward_msg`、`upload_foward_msg`。`send_forward_msg` 当时仅无目标上传变体关闭，指定目标文字合并发送继续可用。该轮台账保留逐账号门控和未通过记录；后续上传恢复见上方 wave5 补充。

最终 wave4r5 的 Linux 全量测试为 1563/1563；镜像内 148 项源码哈希一致、原生模块验证通过、WebUI 已构建。正式镜像部署后，两个账号各 10 步、合计 20/20 通过，健康状态与既有消息映射均保持有效。此次真实范围为登录身份、6 项能力关闭、好友装扮 self/已授权另一账号、每账号一次目标群文字合并、feed 首屏及缓冲分页/同 cursor 重放、本任务闪传标记缺席和 11 帧字节流 smoke。没有继续独立资源上传或 AI 合成，也没有扩大到未授权写入。

逐项范围见私有运行目录中的 `qqapi-200-coverage-20261116.json` 与同名 Markdown；最终环境证据见 `qqapi-wave4r5-linux-tests-20261116.log`、`qqapi-wave4r5-native-verify-20261116.json`、`qqapi-wave4r5-image-verification-20261116.json`、`qqapi-wave4r5-cloud-acceptance-20261116.json`。旧批次失败报告继续保留。

## 第一批

已加入系统表情目录和检索、群消息回应兼容参数、好友分组兼容参数、群文件夹删除、用户状态、群待办、签到名单、在线客户端、Ark 分享和 rkey 查询。底层均经过固定操作路由，不开放任意 SSO/native 调用。

`share_peer` / `send_ark_share` / `share_group_ex` / `send_group_ark_share` 返回 QQ 实际生成的 Ark 字符串，动作名称中的 send 不代表已发送一条聊天消息。`get_online_clients` 保留 QQ 实际设备字段，不编造 OneBot 设备名称；当前版本不支持 `no_cache=true` 强制刷新。

`get_rkey` 与 `get_rkey_server` 验证账号/会话、类型、生成时间和有效期，过期或不完整结果拒绝。`get_rkey_server.expired_time` 使用两个实际 key 有效期的较小值；报告只记录数量和有效性，不记录 key。

## 第二批

群管理读取包含真实设置、分类标签与分享链接；写入包括标签、入群/搜索/机器人/邀请/历史可见性/成员权限选项、批量移除成员和群待办管理。标签参数是 `group_class`，不是群号。批量成员操作必须全批预检，部分失败如实报告。匿名群管理仍未提供已验证的真实操作，返回 unsupported。

收藏表情提供目录、备注、添加、删除、修改、置顶与发送。发送只允许当前账号真实目录中存在的资源，下载固定 QQ 地址并核对摘要，保留动画表情样式。目录写入必须取得完整传输 ACK 并读回目录、备注或顺序。真实 Faceroam 空目录响应的 item.tag4 为 500，表示目录配额，不能与已返回条数相等比较；op1 的完整 ID 容器与账号身份仍必须存在且通过校验。

联系人扩展包含翻译、单向好友首屏、输入状态、全部已读、疑难好友申请及处理、两种过滤群通知查询。单向好友使用自定义 JSON 协议；响应不是标准 OIDB 信封，不能将未知 tag1 当作命令号。仅返回参考接口的最多 99 条首屏，不能据此断言全量好友关系。疑难申请审批使用当前账号、当前会话内观察所得的短期 opaque flag，不接受任意 UID 代替审批凭证。

`fetch_emoji_like` 使用真实消息定位及 QQ 用户分页，保留实际昵称、头像。`cookie` 是绑定账号、会话、消息和表情的加密续页凭证，与参考的数字缓存偏移不同；客户端应原样回传。一次最多返回 150 人，`count=0` 表示采用此上限。不能用单个表情用户列表冒充整条消息的全部回应，也不能编造最近回应时间。

## 云端操作边界与证据

真实云测使用用户指定的两个已有测试账号与测试群；发送测试消息、添加/取消自己测试消息的回应，以及创建并清理临时群文件夹。后续还验证测试群合并转发、独立转发资源上传和本任务临时闪传的恢复及账号历史清理；未知写入结果不自动重传。好友分组、账号资料、收藏表情目录、群设置、成员与申请审批的写入均未执行正向云测。错误参数拒绝仅验证边界，不算真实写入成功。

两个账号的 QQ 收藏均由用户确认没有内容，因此收藏云样本仅证明空列表路径；非空、分类与多页仍待真实对象验证。签到当前真实样本为空名单；成功码精确接受 `0`、`"0"`、`"Succ"`，其他符号值仍失败。

第一批云验保留 legacy 临时文件夹创建的 QQ 权限拒绝（retCode=-36），secondary 创建后删除成功且无遗留清理标记。第二批报告保留最初的目录配额和单向好友解码失败，修复后的验证另存新报告，不覆写历史结果。

证据保存在私有运行目录的各批次 Linux 全量测试、native verify、image verification、deployment 与 cloud acceptance 文件。部署前固定源码快照并核对镜像内哈希，保留旧容器用于回滚，不清空账户数据或消息映射。临时诊断只记录字段类型、数量及业务状态；最终干净镜像必须移除诊断挂钩。

## 第三批及后续契约

群相册接入完整列表、分页列表、媒体列表、点赞/取消、评论、删除、图片和视频上传。上传必须匹配原媒体摘要、目标相册和实际上传者；评论必须包含 QQ 返回的真实作者、正文、时间与 clientKey。当前授权仅做相册读取，未执行相册写入。详见 `group-album.md`。

空间使用固定业务地址、按域 CookieJar 和绑定账号会话的分页凭证，凭据仅在 worker 内使用。`unlike_qzone` 的参考端点未获真实验证，默认关闭。首轮真实测试暴露登录终点 404，后续修复以独立报告保存。wave4r4 两账号的 feed 首屏、count=2 的缓冲分页和同一 cursor 精确重放均已通过；服务器作者号 0 保留为 `system-or-unattributed`，不冒充 QQ 用户，也不放宽写目标账号校验。这只覆盖已记录的读取样本，不覆盖空间写入、全部历史页或其他内容类型。详见 `qzone.md`。

闪传使用固定协议及主文件元数据，列表明确 `complete:false`，不把首屏当成完整目录。发送只有目标 ACK，返回 `message_id:null`，不伪造聊天消息 ID。历史真实临时上传的创建 ACK 未能闭环，生产 r15 的 `create_flash_task` 保持关闭。待部署 r18 源码修正阶段 ACK 与主文件 appid，保留全部上传 ACK 及精确元数据回读，完整创建仍待云验。已用固定原生历史删除取得单次 ACK，并在新的有界目录中确认本任务标记不再出现；wave4r4 双账号最终目录检查保持无该任务标记。此结论仅为当前账号历史条目移除，不代表物理文件销毁、撤销分享或全目录扫描。详见 `flash-transfer-extensions.md`。

`get_mini_app_ark` 返回 QQ 实际生成的 bili/weibo 小程序 Ark。`send_tuwen_ark` 的 Android 图文协议被两个真实 Linux 账号以 901501 拒绝，因此在已验证 QQ 版本上关闭可用性，不将协议 ACK 或生成 JSON 当成客户端渲染成功。`set_group_sign`、`set_diy_online_status` 与行内按钮仅离线验证；按钮只能引用本账号同群实际观察并刷新后仍一致的按钮。

`forward_friend_single_msg`、`forward_group_single_msg` 与参考行为一致：读取原内容，再以当前账号发送，返回真实新消息 ID。支持文本、提及、表情、图片、语音及视频；无法完整恢复的回复、卡片、文件或合并转发在派发前拒绝。两个账号真实文本、图片路径已通过；语音和视频不继承此云验结论。

流式文件、无发送的转发资源上传、AI 语音与原语音转文字分别见 `file-stream-extensions.md`、`forward-extra.md`、`voice-extra.md`。第四批流式样本验证本地字节传输与帧终止，不代表 QQ 语音编码或客户端播放成功。

wave4 历史：转发资源修复 QQ 毫秒时间口径后曾真实创建并读回，但整包字节仍不相等，因此该轮关闭目标 QQ 的 `forwardUpload`，两个上传别名及 `send_forward_msg` 无目标变体在派发前拒绝。指定测试群的文字合并发送当时已通过，独立使用 `mergeCustom`，目录以两个能力的 OR 计算并公开变体状态。后续严格语义回读及恢复结果见上方 wave5 补充，旧失败报告不覆盖。`message_id:0` 始终只是未发送聊天消息的哨兵，不能查询或回应该 ID。

`get_ai_record` 也可能向目标群发布语音，按写动作处理。两个账号的 mode 0、mode 1 均未通过现有完整确认链，mode 1 观测到 `synthesis-body` 业务码 1；该码的服务端语义尚未验证，不能确认是否已发布，也不将其直接称为 QQ 拒绝。目标版本的两个 AI 动作在派发前关闭，不再合成。`fetch_ptt_text` 保持独立能力，其原消息转写不能继承 AI 或字节流测试的通过结论。转发资源的完整字节不一致同样只说明本项目的内容确认链未闭环，并未证明服务器内容错误。

参考中的固定返回、空成功、匿名管理占位及缺失功能均不复制为真实成功。原始 clientKey、cookie、凭据、解密密钥、任意 SSO 请求不开放。整条消息的回应摘要缺少可证明的完整目录及最后回应时间，`get_msg_emoji_likes` 保持明确不支持；单表情分页继续由独立接口提供。多账号 `bot_exit` 在缺少持久的单账号退出契约时不调用全局 `process.exit`。
