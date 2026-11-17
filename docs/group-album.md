# 群相册扩展

本模块对照 `SnowLuma-latest/packages/onebot/src/actions/group-album.ts` 的实际 registry、`packages/core/src/bridge/apis/group-album.ts`、`packages/proto-defs/src/oidb-actions/group-album.ts` 以及 `packages/protocol/src/web/group-album.ts` 独立实现。列表使用 QQ NT 原生 AlbumService，上传使用固定 Qzone Web 服务。本记录和离线测试不代表群相册云端写入已验收。

## 公开动作

所有动作要求 `group_id`；下表省略这个公共参数。`self_id` 如提供必须匹配当前已授权账号。

| 名称 | 其他参数 | 成功 data |
| --- | --- | --- |
| `get_group_album_list` | 无 | 完整旧式相册数组，含 `id/name/picNum/createTime/desc/owner/createuin/createnickname/last_upload_time/cover` |
| `get_qun_album_list` | `attach_info`，默认空串 | `{album_list, attach_info, has_more}`，单页 QQ NT 形状 |
| `get_group_album_media_list` | `album_id`、`attach_info`，默认空串 | `{mediaList,nextAttachInfo}`，单页真实图片或视频元数据 |
| `set_group_album_media_like` | `album_id/batch_id`，可选 `lloc` | `{id,status:0}` |
| `cancel_group_album_media_like` | `album_id/batch_id`，可选 `lloc` | `{id,status:1}` |
| `do_group_album_comment` | `album_id/lloc/content` | `{id,user:{uin},content,time,clientKey}` |
| `del_group_album_media` | `album_id/lloc` | `{success:true}` |
| `upload_image_to_qun_album` | `album_id/album_name/file` | `null` |
| `upload_video_to_qun_album` | `album_id/album_name/file` | `{id}`，服务端真实视频 ID |

`batch_id` 使用实际媒体列表中的十进制字符串，最多 uint64，不转成浮点数。`album_id`、`attach_info`、`lloc` 和相册名称保留原始文本，不猜测为数字。相册名称和创建者昵称中的 Unicode 及字面 `[em]...[/em]` 文本原样保留。

`get_qun_album_list` 中时间、上传数量和 top flag 使用十进制字符串。旧式 `get_group_album_list` 的数值字段必须能被 JSON number 精确表示，否则明确失败；不舍入。完整旧式列表遍历实际分页，最多 32 页、1000 相册和 1 MiB JSON，达到上限或遇到重复 ID/游标时失败，不返回截断列表冒充完整结果。媒体单页和写入前后的完整媒体扫描同样有 1000 项、32 页、1 MiB 及游标前进约束。

媒体响应只有 `prevAttachInfo/nextAttachInfo`，没有目录响应的 `hasMore`。r15 针对云端已观察到的精确结束标记作窄处理：仅在输入游标非空、返回媒体为空且下一游标逐字匹配 152 字节的 `IndexType/DirectType=next`、空 `Lloc`、`StartIndex=0`、全零 `Loc` 定位器时，将 `nextAttachInfo` 归一为空串。其他 opaque 游标、不同 JSON 形态、首屏和非空页保留原值；错相册、重复字段/资源、畸形 UTF-8、游标不前进仍拒绝。这是依据实际服务端响应的修复；SnowLuma 当前原样透传游标，没有这一归一逻辑。

## 原生协议与成功证据

`group-album-protocol.cjs` 仅允许以下固定服务：

- `QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetAlbumList`
- `QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList`
- `QunAlbum.trpc.qzone.webapp_qun_feeds.FeedsReader.GetQunFeedDetail`
- `QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunLike`
- `QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunComment`
- `QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.DeleteMedias`

它们是 QQ NT TRPC 公共封套，不套用 OIDB 编码。相册列表写入 `3331` 业务序列和两个显式空字节字段；点赞、评论和删除分别核对 `5495/8527/8694`。省略的 protobuf 零状态按默认 0 处理，但读操作必须存在真实 data 子消息，不能把只有错误字段或未知字段的数据解释为空集合。所有已知字段校验 wire type、唯一性、UTF-8、整数范围及集合上限。

protobuf bool 按 `0=false`、任意非零 varint 为 `true` 解码，不截断高位；重复字段、错误 wire、畸形 varint 和其他整数范围限制保持。旧实现仅接受 0/1，曾使真实相册媒体列表返回 `Group album boolean is not canonical`，该问题已在 r12 修复。

点赞前从指定群和相册的真实媒体列表确认 batch 与可选 lloc；回执必须包含完全一致的 `421_1_0_...` 目标和期望状态。评论先定位媒体，再请求真实 feed，保留服务端原始 common/user/media protobuf cell 和其中的未知字段，避免重编码丢失必要数据；没有返回的 cell 仅能从已经验证的媒体身份构造。成功评论必须由服务端返回真实 ID、当前账号、准确正文、clientKey 和时间；不会从请求补造成功结果。删除视频先解析真实封面 lloc 和 batch，收到 ACK 后重新完整分页确认目标不再存在，不能因查询错误或缺失元数据而报告已删除。

## 上传边界

`file` 只接受当前账号媒体目录中的 `fwd-image-...` 或 `fwd-video-...` 不透明句柄，以及 canonical `base64://`。拒绝任意本地路径、`file://`、远程 URL 和其他账号资源。图片沿用本项目已经实现的 PNG/JPEG/GIF 字节校验及 10 MiB 上限；WebP/BMP 不因参考仓库支持就跳过本项目媒体验证。视频沿用 50 MiB、完整 H.264 MP4、真实尺寸与时长校验及工作区 FFmpeg 封面生成；没有可用解码器时只禁用视频上传能力。

外层 OneBot action 仍受 16 MiB 请求上限约束，因此较大的视频应使用已经存在的账号媒体句柄。视频临时导入只在账号媒体目录内暂存，并在准备结束后清理，不删除调用方原有资源。FFmpeg 自身的临时文件和缓存遵循工作区 `work/temp`、`work/cache` 约定。

上传前核对真实相册 ID 与名称，并确认媒体列表可读。登录仅允许固定 `ssl.ptlogin2.qq.com`、`ptlogin2.qzone.qq.com/check_sig` 和 `qzone.qq.com` HTTPS 跳转；CookieJar 限制域、路径和有效期，核对登录账号，必要时只向原生 `getPskey` 请求 `qzone.qq.com`。凭据、clientKey、upload session 和服务端原始错误文本不进入 RPC 结果或日志。

上传固定到 `https://h5.qzone.qq.com/webapp/json/sliceUpload/` 的 `FileBatchControl/<digest>`、`FileUpload` 或 `FileUploadVideo`。图片严格按 16 KiB 分片；视频和封面使用服务端返回的有界 slice size，最多 4096 片。每片要求明确 `ret:0`，如返回 session/offset/end/seq 还须完全对应；最终必须返回真实 photo ID 或 video ID。视频先以 SHA1 上传原始视频，再以 MD5 上传实际解码封面，并将封面绑定到返回的 vid。

完整 ACK 后仍要通过原生媒体列表确认返回 ID 与当前账号 uploader；视频还要核对真实封面 ID。没有原生读回不能成功。上传写请求不自动重试，同账号只保留一个实际 HTTP 上传，调用方超时、取消或切换会话不会提前释放仍未结束的物理任务。

读操作和普通相册写共享外层 10 秒总期限；两类上传共享 60 秒媒体期限。每次原生操作最多消耗其中剩余的 10 秒，单个 HTTP 请求最多消耗剩余的 10 秒。整个过程中绑定 epoch、QQ session 对象、UIN 与 UID，切换账号会阻断后续请求和迟到结果。

## 接线与验证

`createGroupAlbum(capture)` 提供 `capabilities/query/action`。公开 RPC 为 `groupAlbumQuery`、`groupAlbumAction`；native operation 为 `fixedGroupAlbum`。OneBot 模块导出 `ACTIONS/READ_ONLY_ACTIONS/EXTENSION_REQUIREMENTS/runGroupAlbum`。

`tests/group-album.test.cjs` 与 `tests/group-album-upload.test.cjs` 共 42 项离线测试通过，涵盖真实 native channel、九项公共 `OneBotService.action`、能力及上传期限、完整分页、精确 ACK/原生读回、固定 Cookie 与 Web 目标、账号隔离、视频与封面两阶段上传、超时和不重试。连同 admin、share、native-channel、媒体、视频和 transports 的定向回归共 167 项全部通过，日志为 `work/group-album-regression.log`。

没有执行真实群相册写入。云端只读验收与后续写入验收由主任务按已经授权的范围单独进行。

后续 [r14q 分页验收](../outputs/qqapi-wave5-readonly-r14q-cloud-acceptance-20261117.json)双账号共 8 次真实公开读取，6 次通过、2 次失败：各自首屏 5 条，第二页为空但返回全零重置定位器，第三页重新读到首屏而被跨页资源唯一性检查拒绝。该轮未证明完整分页；[外部报告](../outputs/qqapi-wave5-readonly-r14q-external-guard-20261117.json)整体同样失败，四项容器/路由/映射/旧证据保留检查均为 true。[原响应诊断](../outputs/qqapi-album-pagination-r14q-diagnostic-20261117.json)只读取已保存的 HTTP 响应，未新增 QQ 调用。r15 修复先以两条失败回归复现问题，再通过相册目标 49/49；正向云端结果须由新批次另记，不能改写 r14q。

2026-11-17 的 [r12q 云端只读验收](../outputs/qqapi-wave5-readonly-r12q-cloud-acceptance-20261116.json)在两个批准账号分别调用旧式目录与媒体列表，共 4/4 通过；均通过目录中的真实 `id` 定位唯一 `test` 相册，首屏各返回 5 条图片记录。两次返回均带非空续页游标，本轮未继续分页、下载照片或验证相册写入。[外部检查](../outputs/qqapi-wave5-readonly-r12q-external-guard-20261117.json)确认运行容器、原配置、17700/17701 路由和消息映射保持。旧 r9q 的验收字段错误及 r10q 的真实媒体解码失败分别保留，不能追改为成功。
