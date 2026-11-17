# 原 18 项接口的替代实现

公开验证概要见 [0.2.0-alpha.3 发布说明](releases/0.2.0-alpha.3.md)；内部执行记录不随源码发布。

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

本轮测试报告作为内部执行记录保存在私有运行目录，文件名为 `qqapi-remaining-*`。凭据、数据库密钥、salt、原始包、账号群号和消息正文不进入报告。云测不执行账号退出/重启、资料设置、群设置、成员禁言或收藏创建。

## wave5 当前态补充

当前目录注册 **210 个 action 名称**，200 个参考名称均有源码实现；不能写成 200 项真实 QQ 业务全部通过。目标 QQ `3.2.35-54395` 当前保留四个门控动作：`get_ai_record`、`send_group_ai_record`、`create_flash_task`、`send_tuwen_ark`。wave4/remaining-r2 曾关闭的两个上传别名及 `send_forward_msg` 无目标分支已在 wave5 双账号共 **6/6** 完成真实资源创建与严格语义回读。仅允许已证头部规范化，完整 MessageBody 字节、节点顺序、作者、名称及时间保持不变，旧失败报告继续保留。

自定义节点支持 `name`/`nickname`、`uin`/`user_id`、真实作者 UID 校验及显式 uint32 秒级 time；零时间使用 QQ 服务端时间。r6 双账号群/私聊、文字/PNG 的 metadata 发送端 24/24 和 接收端 r6rx2 公开查询 16/16、独立 native 根检查 8/8 均通过。只有根绑定后成功识别并严格验证 9/4 时优先返回原始 `resourceNodes`；任一候选的未知或畸形内容整条失败。识别前临时不可用或超出共享 1500ms 探测预算时沿用 QQ 实际 native 元数据，原生 9/175 的 1000 节点、8 MiB、富元素与嵌套读取保留，详见 [转发扩展](forward-extra.md)。历史私聊文件 r3 的双账号失败记录及未取得关联原生错误码的事实继续保留。

r6 转发业务回归见 上传 6/6、消息 38/38 和 兼容性 12/12；兼容性中 8 项为预期拒绝，不能当成新的正向 QQ 业务。历史 r9 云端 Linux 全量 1793/1793、0 失败、0 跳过；native 验证、176 项运行源码哈希及权限与部署保留检查均通过，两个账号的原目录、旧消息映射、17700/17701 分流路由及 AstrBot 配置、容器和插件代码保持。r7 首轮 1773 项中 1767 通过、6 失败，均由新增 observer fixture 目录默认 0755 引发既有私有目录检查；r7a 将测试目录改为 0700 并补 POSIX 权限断言，生产检查保持。r7 失败日志和 r6 1766/1766 历史均保留。

privatefile-r4 双账号各一次 60 字节 TXT，发送及 `get_msg` 共 4/4，通过各一次独立 native `getMessage` 精确核对消息身份、发送者 UIN/UID、peer、文件 UUID/名称/大小及 `sendStatus=2`。各自上传完成诊断精确关联同一单文件元素，`fileErrCode`、`fileSrvErrCode` 均为 0；源文件已清除、健康和旧映射保持。此轮仅证明发送端样本成功；接收账号入站、URL 和下载未由 r4 验证，旧失败根因仍未确认，不能把诊断接线视作发送修复。

privatefile-r5 两账号各一次 60 字节 TXT 和 852 字节 PNG，4 次上传、4 次 `get_msg`、4 次独立 native `getMessage` 精确回读均成功且 `sendStatus=2`；4 次 URL action 均实际调用，全部 retcode 1500，受控云日志为 `nativePrivateFileUrl / INVALID_RESPONSE`。下载 0 次、无下载字节/SHA256 证明，整体验收失败；源文件已清理，账号健康和原映射保持。不证明接收账号入站、旧失败根因修复或状态值语义。出处核对区分云执行 helper `8c9028150125…` 与最终本地 `d1d572673a3e…`：只差部分写失败时的清理，不改发送/URL/下载逻辑。Linux 离线 29/29 属于执行版，最终版 `d1d572673a3e…` 后由 URL-r1 Linux 离线 55/55覆盖其中的 r5 全部 29 项，业务报告记录该依赖哈希；旧 29 项日志仍属于原执行版。

pokerecall-r1 的 8 次写入预算已用完：4 poke、2 次新消息发送、2 recall，无重试。两个群聊 poke 样本（`group_poke` 与 `send_poke`）API 及匹配 native 通知均通过；两个私聊样本（`friend_poke` 与 `send_poke`）API retcode 0，但 15 秒内未见匹配 native 通知。双端受控适配器日志均见 `notice_skipped / identity_mapping / INVALID_REQUEST`，尚未确认具体原因，不能凭 ACK 判为私聊业务通过。两条本任务新发私聊/群消息的发送者独立 status 2、接收者精确回读、撤回后双端通知与精确 native revoke 占位及正 `recallTime` 均通过。三个 mark-as-read action 缺少可暴露的对端未读状态，明确未执行。此批是独立 API 验收，不是 AstrBot 插件验证。

后续只读 shape 诊断时，两账号当前保留 event 均为 0 且初始存在缺口；各账号精确私聊历史在原时间窗内各有 2 条结构化 poke，身份匹配，`peerUinState=validOther`、类型 string。历史存在不等于实时通知通过，也不证实零 `peerUin` 是原失败原因。

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

写入确认强度继续按各 action 区分：kernel ACK、精确目标回读、完整列表中由存在变为缺席，以及完整文件字节/摘要均是不同证据。头像、群名、禁言等未获正向云测的动作不能借用其他 action 的回读或下载结果；空页和已有能力目录也不补齐非空、全分页或写入路径。

以下为 r12 静态参考审计历史（私聊文件选择限制已由上方 r13 更新）：`get_private_file_url` 当时须已知本账号 `message_id`，可选 `file_id` 只作精确筛选，原 UUID/checksum 从 native 记录读取；参考仅传 `file_id`、可选 `user_id`/`file_hash` 的请求形状未兼容，公共 action 默认 OIDB 而不自动回退 classic Offline。`friend_poke` 的参考可选 `target_id` 当前仍被严格参数检查拒绝。`send_poke` 省略群号为私聊、正群号为群聊，0/null/空群号拒绝；三者的 ACK 与实时通知证据须区分。详见 [能力边界](capability-limits.md)，名称实现数不能代替参数或变体覆盖。

group-tempfiles-r1 为 legacy 4 步只读及 secondary 27 步，共 31/31 通过。secondary 仅对本任务新目录和 80 字节 TXT 各派发一次创建、改名、上传、移动、转存、删文件、删目录；移动后与转存后两次完整下载均逐字节及 SHA256 匹配。转存按 `save_file_path` 从新鲜目录记录精确定位，再查详情使用实际 busid；实测该值与 ACK 的 `save_busid` 不同。清理前确认自有文件和空目录，清理后回读缺失，17 个旧文件摘要保持，本地源文件及恢复记录已清除。该写入成功仅属于 secondary 的这一对象范围，legacy 的既有权限拒绝继续保留。

readonly-r8q 双账号共 4/4，fileset 已观察的部分目录与 saved-face 目录均为空页，fileset `completeInventory=false`；16 条依赖 fixture 的读取或发送明确未执行。空页不覆盖完整目录、非空、发送或修改路径。r2历史台账已生成。

历史 metadata-r4 的 4 项图片失败、metadata-r5 发送端通过但接收端失败，以及原 r6rx 的两项失败和跳过均保留。独立诊断 确认两条接收端原生根时间比发送端少 1 秒，接收端 public/cache/native 完全相等；r6rx2 改用接收端独立 native 根精确校验，不放宽转发节点 time。`get_msg` 可读缓存，不是 native 强制刷新证据。

原版 AstrBot 插件方法捕获 r1 因 live mount 布局不符、r2 因 Docker 环境检查失败停止，均未生成 payload、未调用 QQ。2026-11-16 用户反馈防撤回实际使用正常，要求停止该项独立验证；这是用户实测反馈，不是自动化 live 撤回流程通过，不再继续插件捕获或转发重验。r2历史台账已收口；下文 remaining-r2 的全量测试、云场景数和当时门控仅描述历史快照。

## remaining-r2 历史环境验收

2026-11-16，此前 remaining-r2 的 Linux x64 / QQ `3.2.35-54395` 第二轮完整测试为 **1639/1639 通过、0 失败、0 跳过**。原生模块验证通过，运行镜像中的 170 个源文件哈希一致；当时部署镜像 `freshwater-dolphin:qqapi-remaining-r2-20261116`，完整镜像 ID 为 `sha256:4ab6feaefe7cd814d55f36708dce23f14cab6141b832f461f5dd0cea8967d85d`。该记录不代表当前 wave5 运行镜像，旧容器的回滚证据保留。

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

该轮原 18 个名称中有 12 个完成上述范围的双账号正向云验，6 个保留为未执行真实写入；200 个参考名称均已有源码实现，目录为 38 个标准名称和 172 个扩展名称。名称覆盖、会话能力可见和真实业务通过是三个不同结论。remaining-r2 结束时，AI、闪传创建、图文 Ark 和两个独立转发上传别名共 6 项曾保持关闭；wave5 后续恢复上传，当前四项门控和新证据见上方补充。

证据分别为 `qqapi-remaining-r2-linux-tests-20261116.log`、`qqapi-remaining-r2-native-verify-20261116.json`、`qqapi-remaining-r2-image-verification-20261116.json`、`qqapi-remaining-r2-deployment-20261116.json` 与 `qqapi-remaining-r2-cloud-acceptance-20261116.json`。第一轮 3 个短时序测试失败日志及验收脚本前置顺序错误的零场景记录也保留；修正测试使用阶段同步/模拟时钟，未削弱断言，最终第二轮全量通过。

表情非空专项为双账号各 7 个场景，共 **14/14 通过**，证据为 `qqapi-remaining-emoji-cloud-acceptance-20261116.json`。基础与专项合计 60 个场景通过，其中 6 个为预期拒绝。最终健康快照见 `qqapi-remaining-final-health-20261116.json`；管理器 healthy、AstrBot 测试容器运行，双账号保持新鲜的已授权在线状态。
