# 闪传扩展（11 个 action）

协议依据只读参考 SnowLuma 2.4.2（`5dcbfa6f`）的 flash-transfer 定义、固定命令，以及 LLBot 固定提交 `0308b628` 的服务端上传凭据字段和顺序；账号历史删除另以实际 Linux QQ `3.2.35-54395` 的 `wrapper.node` 转换器确认固定 native 契约。所有请求由内部固定 operation 生成；调用者不能指定 SSO 命令、OIDB 模式、native 方法、HTTP 目标或原始 protobuf。`flashCreate` 按 native、HTTP 和账号媒体目录就绪状态计算；完整创建仍待真实云端验收，不会仅凭离线实现或任务受理宣称完成。本次服务端 token 修复是未部署的本地候选，历史验收与门控证据独立保留。

2026-11-16 的 wave4r3 已在副账号真实验证 `delete_flash_file`：对先前创建的唯一临时 fileset，精确 native ACK 后重新查询目录未见目标，报告 `flashCleanupConfirmed=true`；账号健康和既有消息映射保留。验证范围是该账号历史条目移除，不包括物理存储销毁、其他用户副本或全部分享权限撤销。当时创建保持版本禁用，历史验收结论不因本地修复改写。脱敏验收记录：`outputs/qqapi-wave4r3-secondary-cloud-acceptance-20261116.json`。

| Action | 参数 | 返回及边界 |
| --- | --- | --- |
| `create_flash_task` | `files`、可选 `name`、`thumb_path` | `{fileset_id,task_id}`。1..8 个账号私有媒体目录内的非空普通文件；每个最多 1 MiB，总最多 8 MiB。`files` 支持路径、`{file,name}` 或其数组；不支持任意外部路径、远程 URL、base64、符号链接或硬链接。 |
| `get_fileset_info` | `fileset_id` | `{fileset_id,file_list,complete:false}`；固定详情返回，协议没有已证实的完整性标记。 |
| `get_flash_file_list` | `fileset_id` | 上述 `file_list` 数组；同一固定详情查询，不能解释为已证实的全部主文件清单。 |
| `list_filesets` | 无 | `{file_list,complete:false}`；只返回 `0x93d2` 已知固定请求的结果。参考没有分页终止契约，不能声称账号全量目录。 |
| `get_share_link` | `fileset_id` | 官方 `https://qfile.qq.com/q/<code>` 字符串；缺失或歧义则失败。 |
| `get_fileset_id` | `share_code` | `{fileset_id}`；仅官方 HTTPS 分享页或分享码，禁止重定向，HTML 最多 2 MiB；仅接受唯一命名 `fileset_id`，提取后再查询当前账号的访问权限。 |
| `get_flash_file_url` | `fileset_id`、可选 `file_index`、`file_name` | `{url}`；真实索引从 **1** 开始，默认 1；可选文件名须与该索引完全相符。 |
| `download_fileset` | 同上 | `{url,file_name,file_size}`；仅解析主文件直链，不向磁盘下载。当前已知元信息页最多 18 条，找不到索引即失败，不猜测后续页。 |
| `delete_flash_file` | `fileset_id` | `null`；仅当前账号真实目录中出现、本会话上传完成或本账号私有恢复记录中由自身创建实际分配的 fileset；精确 native 结果与目录回读确认账号历史条目移除，不宣称物理存储销毁或撤销其他用户访问。 |
| `rename_flash_file` | `fileset_id,new_name` | `null`；同一账号归属校验，固定 ACK 后须详情回读精确新名称。 |
| `send_flash_msg` | `fileset_id`，`user_id`/`group_id` 二选一 | `{sent:true,message_id:null,confirmation:'target_ack'}`；固定响应只确认目标，不返回普通消息 ID，不能据此查消息或撤回。 |

详情行包含真实出现的 `fileset_id,file_name,orig_name,size,type,share_url`。不补造缺失字段；uint64 大小超过 JS 安全整数时保留十进制字符串。`0x93d3` / `0x93d4` 的下载字段是缩略图，不作为主文件 `download_url` 暴露。

## 上传确认

上传使用 `0x93cf_1` 申请、`0x93d0_1` 一次提交全部带独立序号的文件、`0x93db_1`，随后对每个主文件执行 `0x12a9_100` preflight；若返回 uKey，先向固定 `https://multimedia.qfile.qq.com/sliceupload` POST 并确认切片 protobuf 业务状态为 `success`，再发 `0x12a9_103` commit。秒传分支可以没有 uKey，但仍须同一次 preflight 返回完整服务端 token/time/ttl。缺失时立即停止，不自行构造 fileId，也不把普通 ACK 当成授权凭据。之后对两种协议关联缩略图执行同样顺序、`0x93d1_1` 状态 6，并回读每个主文件的 UUID、索引、名称、大小及精确服务端 token。仅任务受理、HTTP 200 或上传中状态均不返回完成。

主文件 sliceupload appid 为 **14901**，PNG 缩略图为 14903，JPG 协议缩略图为 14902；下载申请仍以 field103=22 对应 appid 14901。fileId 现在视作有界、不含控制字符的不透明服务端字符串，不解码它推断 appid、不转换 base64/base64url、不去 padding、不重写 `+` 或 `/`。先前本地生成主文件 fileId 的历史 appid 修正不能替代服务端签发。提交前的 create/commit/complete/ready 请求在此前离线检查中与参考独立编码一致；本次未改这些固定操作。

本地候选的服务端凭据路径依据 [LLBot 固定提交 0308b628 的响应 schema](https://github.com/LuckyLilliaDev/LuckyLilliaBot/blob/0308b6285fea138ecf199f0baebbf400752e26c6/src/ntqqapi/proto/oidb.ts#L1469)：解开 OIDB body 后，`f2.f6.f1.f1` 内 `f2` 为 token string、`f4/f5` 为 time/ttl uint32；uKey 为独立的 `f2.f1`。token/time/ttl 必须存在、类型正确且唯一；显式零数值原样保留，不补当前时间或固定 TTL。`0x12a9_103` 使用同一组值，切片失败或 commit 结果不确认均停止后续写操作。尚未证明所有非秒传或缩略图响应都含此 summary；没有它便明确失败并保留已分配 fileset 的 `cleanup_pending`，不从其他未证实路径或本地随机值兜底。候选尚待云端真实字段与内容验收，不宣称已解决新建样本的 invalid rkey。

上传后的主文件元信息最多读取三次，尚未齐备时相隔 1 秒，只等待同一 fileset 中合法条目缺失或 fileId 尚未出现。身份、索引、UUID、名称、大小或已出现 fileId 冲突以及查询错误立即失败。只读等待仍受原 60 秒总时限、调用方 deadline、取消和会话变更约束；不会重发任何创建、登记、上传或就绪写步骤。

当前单片上限为 1 MiB，上传内容是读入后的不可变快照，哈希、注册大小与上传字节一致。单片 SHA1 state 使用整文件最终 SHA1；没有复制参考项目中大文件累积 SHA1 的未经本模块验证实现。默认按参考生成 526×360 PNG 封面并分别注册 PNG/JPG 协议类型；这是通用封面，不宣称为文档预览。提供 `thumb_path` 时须是账号目录内 526×360 PNG。不会在真实账号自动重试写操作或清理远端部分上传。

创建前先校验并原子写入账号媒体目录内的私有 `fwd-flash-recovery.json`；QQ 实际返回分配的 fileset UUID 后，在发送 commit 前将其持久化。记录绑定精确 UIN/UID，仅保存创建获得的 UUID、固定进度和时间；不收录目录查询或分享文件。文件使用独占临时文件、0600、fsync 和原子替换；读取拒绝符号链接、硬链接、账号错配、坏 schema 及超出 256 KiB/1,000 条的记录，POSIX 同时验证所有者和私有权限。运行目录须遵守项目既有账号独占锁。

失败后保留 `cleanup_pending` 与最后成功阶段，错误仅附固定阶段标记。即使会话切换或进程重启，本账号仍可显式调用删除该部分上传，无需它先出现在完整目录/详情；这一恢复资格不允许重命名或发送，也不授予其他账号。只有精确 native ACK 且重新查询目录未见该 ID 后才移除记录，不自动删除、不自动重放。取消后若底层仍返回真实分配 UUID，也先记录再停止后续 mutation。若网络未返回 UUID 或存储在实际分配后发生故障，恢复记录不能重建未知 ID；不把未确认创建包装为完成。

## 下载、安全与运行限制

主文件元信息来自 `0x93d4_1` 的 `f14.f1`，URL 来自 `0x12a9_200`，不能退回缩略图。严格校验媒体步骤 seq/sub、成功头、目标 fileset/file UUID、唯一 `multimedia.qfile.qq.com` 主机、`/download` 路径、appid 14901、请求中的精确 fileId 和唯一非空 rkey。官方 URL 的 fileid 用 URLSearchParams 解码后与不透明服务端 token 完全比较；重复或编码后同名的 fileid 参数也拒绝。URL 原文不重写，裸 `+` 不猜成 `%2B`，其他 host/appid 不能放宽。上传 token、uKey 不进入公共结果、日志或恢复文件；主文件授权 URL 中的 rkey 是该 URL 自身的一部分。

真实 QQ 回包的独立凭据字段可为 `rkey=...` 或 `&rkey=...`；解析器只接受这两种完整字段，拼接时去掉单个前导 `&`。空值或畸形字段不能补齐凭据；重复的合法独立凭据、与路径内凭据冲突及最终 URL 缺少唯一非空凭据仍失败。不使用图片接口的 rkey 补齐闪传凭据。

删除、重命名、发送先检查当前账号目录成员资格；仅显式删除另支持上述本账号恢复记录，分享链接可访问性不授予写权限。每个 fileset 同时最多一个写操作；同会话中相同参数的写请求一经发出即不再重放，包括未确认结果。会话切换清空内存归属与写记录，保留账号绑定的恢复文件，也不会提前释放仍未完成的 4 个物理任务槽位。创建总时限 60 秒，其他操作 10 秒，每个 native 步骤最多 10 秒。响应与 RPC 均最多 1 MiB，HTTP 分享页最多 2 MiB，切片 ACK 最多 64 KiB，protobuf 共享字段预算 20,000。

参考定义的 `0x9407_1` 在真实版本返回目录分类结构；公共删除流程不再调用该命令。固定 `getFlashTransferService().batchRemoveUserFileSetHistory` 只接收内部生成的 `{seq,fileSetIdList:[filesetId],cancelOnDeleteUserRecords:false,cancelFileSetIdList:[]}`，不提供取消其他任务的目标。返回必须是 `{rsp:{seq,result,errMs}}`，要求 seq 精确对应、result 为数值 0，再重新查询当前账号目录确认该 ID 未出现。对当前有界目录的缺席回读不等同于证明物理文件销毁、全量分页清单或其他用户分享权限已撤销。

仅 complete/ready 按固定参考的空响应类型使用精确匹配且成功的 OIDB envelope 作为阶段 `server_ack`，允许有界 opaque body；这不替代切片成功 ACK 和全部主文件精确元信息回读。rename/delete 的未知非空业务 ACK 仍失败。历史协议诊断最多暴露 protobuf tag/wire/count、有限嵌套结构及 UUID 是否等于请求的布尔值；对已定位的旧 delete 结果形状，仅另暴露 f1/f2 不超过 65535 的数值（更大值标为 large），f3 只识别精确 success/error 枚举，其余仅字节长度、UTF-8 有效性及 SHA256。不输出原始字符串、包字节、UUID、身份或凭据。

## 接线与验证

`createFlashTransfer(capture, options)` 提供 `execute/capabilities/clear`；固定 RPC `flashTransfer`，native op `fixedFlashTransfer` 对应 `flash-transfer-protocol.cjs`。能力键为 `flashRead/flashDownload/flashResolve/flashWrite/flashDelete/flashCreate`；删除独立依赖 `flashDelete`，不连带禁用重命名、发送；没有新增监听器。OneBot 模块导出 `ACTIONS/REQUIREMENTS/WRITE_ACTIONS/runFlashTransferActions/parameters`。HTTP 参数 schema 需要 `file_index` 为整数；`fileset_id/share_code/new_name/file_name/thumb_path/name` 为字符串；`files` 保留数组/对象结构，不拆为任意脚本。

离线测试覆盖固定 command/sub/mode、显式零值、主文件/缩略图区分、精确身份与大小、全部上传阶段、文件目录边界、HTTP 限制、取消/会话切换的物理并发占用及写操作不重放。恢复回归另覆盖 commit 前持久化、部分失败、跨实例/会话显式删除、跨账号及共享文件拒绝、失败 ACK 保留记录、迟到分配、容量预留与链接/权限/schema 校验；Windows 无符号链接权限时只验证硬链接拒绝，POSIX 权限用例仅在 POSIX 运行。此前额外用参考项目原始 TypeScript schema 经其 `ProtobufCompiler` 独立编译，7 组纯合成 prepare/apply（主文件、PNG、JPG）及主文件 download 编码逐字节一致；这是历史证据，不覆盖本次服务端 grant 的新语义。本次另覆盖服务端 summary 字段、缺失/重复/错型凭据与 U32 边界、原值重用、上传后 commit、缺 token 零上传、切片失败零 commit、未知 commit 结果与恢复，以及不透明 token 的精确 URL 参数比较。没有把真实账号身份、包内容或上传凭据作为测试 fixture。

2026-11-17 的 [r11q 只读验收](../outputs/qqapi-wave5-readonly-r11q-cloud-acceptance-20261116.json)使用批准测试群实际缓存的官方分享链接，两个账号的 `get_fileset_id`、`get_fileset_info`、`get_flash_file_list`、`get_share_link` 共 8/8 通过，详情与列表仅证明同一条实际元数据和分享链接闭环。该批两次 `download_fileset` 失败与两个 URL 别名跳过保留；[已存回包的离线分析](../outputs/qqapi-wave5-flash-url-shape-offline-r3-report.json)证实独立凭据带有前导 `&`，原解析器漏识别。

修复在 r12 云端部署后，[r13q](../outputs/qqapi-wave5-readonly-r13q-cloud-acceptance-20261116.json)两个账号各一次 `download_fileset` 和 `get_flash_file_url`，共 4/4 通过；URL 对原始主文件元信息中的精确 fileId 校验，文件名、大小与实际索引 1 相符。[外部检查](../outputs/qqapi-wave5-readonly-r13q-external-guard-20261117.json)确认运行容器、配置、双路由及消息映射保持。本轮未下载闪传文件字节，未验证内容摘要、完整目录、创建或发送，历史失败不改写。
