# 文件与流式传输（8 个 action）

这组能力运行在账号的 OneBot 服务进程，不引入 QQ 的任意 RPC。每次操作与当前真实登录身份和 epoch 绑定；HTTP、正向 WebSocket、反向 WebSocket 和内部 HTTP 管理入口均有实际流式 sink。无 sink 直接拒绝流式调用。

| Action | 参数与结果 |
| --- | --- |
| `upload_file_stream` | `stream_id`、新流必需 `total_chunks`；分块使用 `chunk_index`（0-based）和规范 base64 `chunk_data`；可选 `filename,file_size,expected_sha256,file_retention`。每次分块 ACK 为 `type:'stream'`，全部 ACK 后另发 `is_complete:true`，才返回 `type:'response',status:'file_complete',file_path,file_id,file_name,file_size,sha256`。`verify_only:true` 查询，`reset:true` 丢弃该流未完成分块。 |
| `download_file_stream` | `file` 或 `file_id` 二选一（同时提供须相同），可选 `chunk_size`。接受本账号本会话签发的文件 handle/路径、已缓存媒体 ID，或通过公共网络检查的 HTTP(S) URL。依次发送 file_info、file_chunk，最后 file_complete。 |
| `download_file_image_stream` | 同上；选择缓存 ID 时须为本账号图片。 |
| `download_file_record_stream` | 同上；选择缓存 ID 时须为本账号语音。 |
| `test_download_stream` | 可选布尔 `error`；实际推送 10 个 data_chunk，随后 data_complete；`error:true` 在 10 帧后终止为错误帧。 |
| `clean_stream_temp_file` | 无参数；仅清理持久 manifest 记录的非活动流文件，返回 `{message:'success',removed,freed_bytes,skipped_active}`。不递归删除目录、不扫掉其他账号媒体或未登记文件。 |
| `download_file` | `url` 或规范 `base64` 二选一，可选 `name,headers`；在账号媒体目录的专属 `fwd-streams/` 内保存文件，返回 `{file,file_id}`。只接受生成的目的路径，调用者不能指定任意磁盘位置。 |
| `get_file` | `file` 或 `file_id`；解析本账号本会话已签发的流文件或已有 `fwd-image/video/record-*` 媒体资源，返回真实元信息。普通 QQ 群文件 UUID 没有上下文时不会伪造结果。 |

## 传输语义

HTTP 使用 `application/x-ndjson`，每个 JSON 对象独占一行；正反向 WS 使用重复 JSON 消息。每帧保留请求的完整 `echo`，含 false、null 和对象，并标记 `stream:'stream-action'`。中间数据 `type:'stream'`，最终成功 `type:'response'`；失败包 `status:'failed'` 且 `data.type:'error'`。上传分块请求只产生该次 ACK；它不等于整文件完成。重置返回 `type:'reset'`。

每个 sink.send 等待真实 HTTP writable 回调或 WS send 回调，最大单帧 1 MiB、WS 缓冲上限 2 MiB、单次写等待最多 10 秒。业务逐帧检查 session 和取消信号；连接关闭、网络节点停止或账号替换会中断后续帧。返回旧请求的帧不会转到新 WS 连接。没有吞掉中间帧的 NOOP fallback。

## 资源和磁盘

单文件上限 32 MiB，单上传块/下载帧数据最多 256 KiB（默认下载 64 KiB），每流最多 4,096 块，最多 8 个未完成上传，账号流目录预算 128 MiB、最多 8,192 条登记文件。完成合并前先预留最终文件空间，因而分块和最终文件同时存在也在预算内。最多 4 个实际文件任务；调用者取消不会提前释放仍被阻塞的任务槽位。

文件内容写入账号私有媒体目录内的随机 handle 名称，不用 display filename 拼路径。分块可乱序；重复索引须字节长度与 SHA256 相同，不能把不同内容当作幂等成功。合并按索引顺序、流式写盘并校验整文件 SHA256；本地文件每次解析/传出会复核内容摘要。默认完成文件保留 5 分钟，允许 1..600,000 毫秒；不支持永久保留 0。到期文件在下一次文件操作或显式清理时回收。未完成流闲置 10 分钟后在下一次操作回收，会话替换也使旧上传失效。

`manifest.json` 原子替换，记录本模块自身签发文件与实际大小，重启时据此重建配额。只有相同账号身份和 epoch 能使用旧 handle；重启后未完成上传不会恢复合并状态，其登记分块可由清理接口回收。manifest 异常、符号链接、硬链接或登记文件大小改变时拒绝继续，不能借重启绕开配额。运行模型沿用现有每账号 data lock，要求同一账号媒体目录只有一个 OneBot 服务写入；它不是多进程共享数据库。崩溃正好发生在文件写入与 manifest 更新之间时，启动会拒绝不一致状态；不会自动删除未登记文件或猜测修复。

## URL 与期限

远程源仅允许公共 HTTP(S)、标准端口和不含登录信息/fragment 的 URL。拒绝私有、环回、链路本地、组播、文档、过渡及映射 IP；DNS 的所有候选地址都须通过公共地址检查。实际连接通过自定义 lookup 固定到已校验地址，保持原域名 TLS 校验，禁用连接池，不二次任意解析，不使用代理，不跟随重定向。拒绝压缩响应、异常/过大 Content-Length，读取过程再次限字节；源连接/读取空闲 10 秒即超时。

外部 header 仅允许有限长度的 Accept、Accept-Language、User-Agent、Referer 对象，拒绝 Cookie、Authorization、Host 等。下载不会将账号凭据转发给任意 URL。普通文件操作总时限在服务剩余预算内最多 60 秒；DNS 或存储系统未真正结束时任务槽位仍占用。持续阻塞可能耗尽该账号 4 个槽位；这会拒绝新工作，避免超时后无限堆积后台任务。

验证包括 10 项业务/网络安全测试、6 项实际 HTTP/正反 WS 集成（含真实 OneBotService 的 ALS sink 接线），并与现有 transport/runtime/fairness 测试共 49 项通过。云端 QQ 写入不属于这组本地网络测试的验证结论。
