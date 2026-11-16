# 闪传扩展（11 个 action）

协议依据只读参考 SnowLuma 2.4.2（`5dcbfa6f`）的 flash-transfer 定义、固定命令和上传流程；账号历史删除另以实际 Linux QQ `3.2.35-54395` 的 `wrapper.node` 转换器确认固定 native 契约。所有请求由内部固定 operation 生成；调用者不能指定 SSO 命令、OIDB 模式、native 方法、HTTP 目标或原始 protobuf。真实目标版本的创建流程尚未取得可识别的完成 ACK，因此 `flashCreate=false`，创建在媒体读取、恢复记录和网络写操作之前返回 `UNSUPPORTED`。不会仅凭离线实现或任务受理宣称完成。

2026-11-16 的 wave4r3 已在副账号真实验证 `delete_flash_file`：对先前创建的唯一临时 fileset，精确 native ACK 后重新查询目录未见目标，报告 `flashCleanupConfirmed=true`；账号健康和既有消息映射保留。验证范围是该账号历史条目移除，不包括物理存储销毁、其他用户副本或全部分享权限撤销。创建仍保持上述版本禁用。脱敏验收记录：`outputs/qqapi-wave4r3-secondary-cloud-acceptance-20261116.json`。

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

上传使用 `0x93cf_1` 申请、`0x93d0_1` 一次提交全部带独立序号的文件、`0x93db_1`、各文件 `0x12a9_100/103` 注册，再 POST 固定 `https://multimedia.qfile.qq.com/sliceupload`。所有主文件先注册再传字节；每片 protobuf 的业务状态须为 `success`。之后上传两种协议关联缩略图、`0x93d1_1` 状态 6，并回读每个主文件的 UUID、索引、名称、大小及 fileId。仅任务受理、HTTP 200 或上传中状态均不返回完成。

当前单片上限为 1 MiB，上传内容是读入后的不可变快照，哈希、注册大小与上传字节一致。单片 SHA1 state 使用整文件最终 SHA1；没有复制参考项目中大文件累积 SHA1 的未经本模块验证实现。默认按参考生成 526×360 PNG 封面并分别注册 PNG/JPG 协议类型；这是通用封面，不宣称为文档预览。提供 `thumb_path` 时须是账号目录内 526×360 PNG。不会在真实账号自动重试写操作或清理远端部分上传。

创建前先校验并原子写入账号媒体目录内的私有 `fwd-flash-recovery.json`；QQ 实际返回分配的 fileset UUID 后，在发送 commit 前将其持久化。记录绑定精确 UIN/UID，仅保存创建获得的 UUID、固定进度和时间；不收录目录查询或分享文件。文件使用独占临时文件、0600、fsync 和原子替换；读取拒绝符号链接、硬链接、账号错配、坏 schema 及超出 256 KiB/1,000 条的记录，POSIX 同时验证所有者和私有权限。运行目录须遵守项目既有账号独占锁。

失败后保留 `cleanup_pending` 与最后成功阶段，错误仅附固定阶段标记。即使会话切换或进程重启，本账号仍可显式调用删除该部分上传，无需它先出现在完整目录/详情；这一恢复资格不允许重命名或发送，也不授予其他账号。只有精确 native ACK 且重新查询目录未见该 ID 后才移除记录，不自动删除、不自动重放。取消后若底层仍返回真实分配 UUID，也先记录再停止后续 mutation。若网络未返回 UUID 或存储在实际分配后发生故障，恢复记录不能重建未知 ID；不把未确认创建包装为完成。

## 下载、安全与运行限制

主文件元信息来自 `0x93d4_1` 的 `f14.f1`，URL 来自 `0x12a9_200`，不能退回缩略图。严格校验媒体步骤 seq/sub、成功头、目标 fileset/file UUID、唯一 `multimedia.qfile.qq.com` 主机、`/download` 路径、appid 14901、请求中的精确 fileId 和唯一非空 rkey。上传 rkey 从不进入公共结果、日志或 RPC。主文件授权 URL 中的 rkey 是该 URL 自身的一部分。

删除、重命名、发送先检查当前账号目录成员资格；仅显式删除另支持上述本账号恢复记录，分享链接可访问性不授予写权限。每个 fileset 同时最多一个写操作；同会话中相同参数的写请求一经发出即不再重放，包括未确认结果。会话切换清空内存归属与写记录，保留账号绑定的恢复文件，也不会提前释放仍未完成的 4 个物理任务槽位。创建总时限 60 秒，其他操作 10 秒，每个 native 步骤最多 10 秒。响应与 RPC 均最多 1 MiB，HTTP 分享页最多 2 MiB，切片 ACK 最多 64 KiB，protobuf 共享字段预算 20,000。

参考定义的 `0x9407_1` 在真实版本返回目录分类结构；公共删除流程不再调用该命令。固定 `getFlashTransferService().batchRemoveUserFileSetHistory` 只接收内部生成的 `{seq,fileSetIdList:[filesetId],cancelOnDeleteUserRecords:false,cancelFileSetIdList:[]}`，不提供取消其他任务的目标。返回必须是 `{rsp:{seq,result,errMs}}`，要求 seq 精确对应、result 为数值 0，再重新查询当前账号目录确认该 ID 未出现。对当前有界目录的缺席回读不等同于证明物理文件销毁、全量分页清单或其他用户分享权限已撤销。

rename/complete/ready 的未知非空业务 ACK 保持失败，不能仅因 envelope 成功就接受未识别语义。历史协议诊断最多暴露 protobuf tag/wire/count、有限嵌套结构及 UUID 是否等于请求的布尔值；对已定位的旧 delete 结果形状，仅另暴露 f1/f2 不超过 65535 的数值（更大值标为 large），f3 只识别精确 success/error 枚举，其余仅字节长度、UTF-8 有效性及 SHA256。不输出原始字符串、包字节、UUID、身份或凭据。

## 接线与验证

`createFlashTransfer(capture, options)` 提供 `execute/capabilities/clear`；固定 RPC `flashTransfer`，native op `fixedFlashTransfer` 对应 `flash-transfer-protocol.cjs`。能力键为 `flashRead/flashDownload/flashResolve/flashWrite/flashDelete/flashCreate`；删除独立依赖 `flashDelete`，不连带禁用重命名、发送；没有新增监听器。OneBot 模块导出 `ACTIONS/REQUIREMENTS/WRITE_ACTIONS/runFlashTransferActions/parameters`。HTTP 参数 schema 需要 `file_index` 为整数；`fileset_id/share_code/new_name/file_name/thumb_path/name` 为字符串；`files` 保留数组/对象结构，不拆为任意脚本。

离线测试覆盖固定 command/sub/mode、显式零值、主文件/缩略图区分、精确身份与大小、全部上传阶段、文件目录边界、HTTP 限制、取消/会话切换的物理并发占用及写操作不重放。恢复回归另覆盖 commit 前持久化、部分失败、跨实例/会话显式删除、跨账号及共享文件拒绝、失败 ACK 保留记录、迟到分配、容量预留与链接/权限/schema 校验；Windows 无符号链接权限时只验证硬链接拒绝，POSIX 权限用例仅在 POSIX 运行。额外用参考项目原始 TypeScript schema 经其 `ProtobufCompiler` 独立编译，7 组纯合成 prepare/apply（主文件、PNG、JPG）及主文件 download 编码逐字节一致（284/286/286/330/332/332/224 字节）。没有把真实账号身份、包内容或上传凭据作为测试 fixture。
