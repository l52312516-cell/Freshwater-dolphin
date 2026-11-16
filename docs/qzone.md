# QQ 空间扩展

实现来源是只读参考仓库 SnowLuma 2.4.2（提交 `5dcbfa6f297b9dd112d859c2793687f8ed4bf563`）的 `packages/onebot/src/actions/qzone.ts`、`packages/core/src/bridge/apis/web.ts`、`packages/protocol/src/web/qzone.ts` 与 feed cursor/content 模块。没有修改参考项目，也没有复用其开放式 HTTP 代理。

源码和离线契约验证之外，已对两个现有测试账号完成有限范围的真实空间读取验收，未执行任何真实空间写操作。存在代码、当前账号具备 native 方法、离线测试通过均不代表全部 QQ 空间路径已验收。参考源码本身标注了取消赞端点、评论 `topicId` 后缀及部分写回执仍需真机确认；此处保留这些验证边界。

## 动作与参数

| 动作 | 参数 | 结果 |
| --- | --- | --- |
| `get_qzone_msg_list` | `target_uin?`, `pos=0`, `num=20`（1–100） | `{total,msglist}`，真实总量及当前页 |
| `get_qzone_msg_detail` | `tid`, `target_uin?`, `pos=0`, `num=20`（1–100） | `{tid,content,comment_num,comments}`，含服务端内联回复 |
| `get_qzone_feeds` | `page_num=1`, `count=10`（1–50）, `cursor?` | `{feeds,has_more,next_cursor}` |
| `send_qzone_msg` | `content`, `images?`, `ugc_right=1`, `target_uins?` | `{tid,time}` |
| `delete_qzone_msg` | `tid` | 业务回执确认后 `null` |
| `set_qzone_msg_right` | `tid`, `ugc_right`, `target_uins?` | `{ugc_right}`，业务回执及权限值回读 |
| `like_qzone` | `tid`, `target_uin?`, `abstime=0` | 业务回执确认后 `null` |
| `unlike_qzone` | 同点赞 | 默认不可用，端点待真实协议验证 |
| `comment_qzone` | `tid`, `content`, `target_uin?`, `images?`；可选父评论与被回复者参数 | `{comment_id}`，楼中楼另有父评论身份 |
| `set_qzone_ban` | `user_id`, `enable=true` | 业务回执确认后 `null` |

未指定 `target_uin` 时使用真实当前账号。QQ 号必须是精确的正 uint32；说说和评论 ID 接受 1–128 字符字母、数字、下划线或连字符，评论编号 `0` 有效。正文保留首尾空格和换行，最多 32 KiB，不接受全空白正文。未知字段直接拒绝。

可见性只接受 `1/4/16/64/128`；16/128 必须提供不重复的 `target_uins`，最多 100 人，其他可见性不接受作用名单。权限更新先读取属于本账号的完整说说，只支持能够无损重建的文字/图片说说。图片必须有真实标识、类型、尺寸及原始 `bo` 参数；不支持的富媒体或缺失字段会在写入前失败。保留完整正文，不做 `trim()`。权限回读确认真实 `ugc_right`，指定用户名单只由固定请求与成功回执证明，尚无源确认的完整名单回读协议。

普通评论允许图片。楼中楼必须同时提供 `comment_id/comment_uin`；可选的 `reply_uin/reply_name` 也必须成对，且必须已有父评论。父 ID 指一级评论，不能用二级回复 ID 替代；楼中楼只支持文字。创建评论必须返回真实新 ID；只有成功状态但没有新 ID 时返回异常，提醒调用方自行确认投递，绝不返回父 ID 或空串冒充。

## 图片、请求和回执

图片只接受本账号 `fwd-image-…` 句柄和规范 `base64://` PNG/JPEG/GIF，不接受外部 URL、文件路径或 `file://`。最多九张，全部解码数据合计 10 MiB。OneBot 进程将 base64 转成本账号私有资源句柄，IPC 不携带大图片。worker 在认证或上传前完整读取并校验全部图片，固定上传到 `up.qzone.qq.com/cgi-bin/upload/cgi_upload_image`，不使用调用者提供的目的地址。上传必须返回真实图片元数据，发布使用 richval，评论使用直链，两者不能混淆。丢失 RPC 响应时暂留导入句柄，避免尚未结束的 worker 失去输入；这些句柄计入既有账号缓存配额。

所有业务 CGI 仅使用源码中固定的 `h5.qzone.qq.com`、`user.qzone.qq.com` 和 `up.qzone.qq.com` 路径。业务请求不跟随重定向。认证由当前 QQ 的 `ticket.forceFetchClientKey` 换取 Cookie，跳转仅允许固定 ptlogin 路径与同一账号的 `https://user.qzone.qq.com/<self>/infocenter`；缺少 `p_skey` 时只向 native 请求 `qzone.qq.com` 域。终点必须 HTTP 200，404 不会被接受为成功认证。失败消息仅包含固定认证阶段与 HTTP 状态；可选离线诊断回调只给出阶段、状态及 Cookie 域类型数量。Cookie、skey、p_skey、client key 全留在 worker，不进入 RPC 结果、游标、日志或持久配置。Cookie 校验账号、域、路径和有效期，其他域凭据不会发送给空间。

所有写操作要求显式 `code=0` 或 `subcode=0`，任何同时存在的非零字段都失败；HTTP 200、空对象、字段缺失或数值字符串 `"0"` 都不能证明成功。发布还必须有真实新 tid 和时间；删除前必须取得本账号所有权证据。删除、点赞、拉黑目前只证明服务器业务回执，不能宣称完成了独立最终状态回读。任何写操作都不自动重试，图片已上传后发布失败可能留下空间端孤立图片。

只有列表查询在精确 `code=-10000` 时允许一次源确认的只读替代路径；其他失败直接返回异常。禁止把认证失败、异常回包或缺失数组当作空列表。

## 好友动态与并发边界

好友动态接受已知 JSONP 包装与受限 JS 数据字面量，支持单引号、十六进制转义、`undefined` 和数组占位；不使用 `eval`、VM 或浏览器执行。函数、表达式、getter、模板字符串、重复/原型字段、非有限或不精确整数、超深对象都会拒绝。HTTP 响应最多 2 MiB，解析深度 32、节点数 30000，RPC 结果最多 1.5 MB。

HTML 原样保留；结构化正文只读取该作者、feed key 对应的已知正文节点，排除评论、被动转发、头像与视频封面。无法识别时 `tid/content/content_complete/images` 为 `null`，未知统计为 `null`，不伪造零值或空内容。

真实 feed CGI 会返回作者 `uin=0` 的系统或未标注作者条目。仅在动态条目的作者字段保留这一服务端原值，并标记 `author_kind:"system-or-unattributed"`；非零作者标记 `author_kind:"qq-user"`。零值不表示可访问的真实 QQ 账号，也不能作为目标账号、评论作者或写操作参数；缺失作者字段仍失败，不默认补零。所有源条目照原顺序保留，包括这些条目在 count 分页溢出中的位置。

源 CGI 可能忽略 count 或附加置顶、广告项。每个源页完整验证，最多 250 个含空占位的槽位和 150 个真实条目；不能因为超过请求 count 就截断丢项。worker 将完整源页保存在有界内存快照，对外每次最多 count 条，先按原顺序消费该源页全部剩余条目，再使用源页真实 nextState 请求下一源页。源页边界处公共页可以不足 count；`has_more` 同时考虑本页剩余条目和服务端结束标志。相同游标可重读同一快照片段，不靠重抓动态首页恢复溢出内容。

wave4r4 两个测试账号均真实通过 `count=2` 首页、源页缓冲的下一段无重复，以及相同游标精确重放；证据为 `outputs/qqapi-wave4r4-cloud-acceptance-20261116.json`。本次返回的前两段没有作者零值条目，但完整源页解析已不再被后续系统作者零值阻断。首次服务端超出 count 的失败及后续作者零值被误拒绝的失败保留在各自历史验收报告中，修复后成功另存新报告。这些样本尚未验证源页耗尽后跨 CGI 源页续取、完整遍历结束、全部动态类型或任何空间写入。

游标只携带 opaque 快照引用、偏移和绑定字段，并使用随机 HMAC 密钥认证，绑定真实 QQ 号、epoch、实例世代和 count，五分钟过期；不包含正文、HTML、Cookie 或服务端私密分页数据。每账号最多 32 个源页快照、合计 16 MiB，单页最多 4 MiB；达到配额时明确拒绝新源页，已保留的溢出内容仍可消费。会话重置清空所有快照。源页位置历史最多 256 页，`icServerTime` 单独变化不能证明续页推进；缺少真实结束标志、循环、停滞或超限分页均失败。无游标的页码最多 20 个公共页，按同样的快照消费顺序读取；服务端明确结束且剩余条目耗尽后，请求更深页面才能返回真实空页。

每账号最多四个尚未结束的物理操作和一个空间写操作。调用方超时不释放底层未完成操作的占位或写锁。所有 await 后检查账号、uid、session、epoch、实例世代及总期限，总期限最多 60 秒，单次 HTTP 最多 10 秒。`clear()` 使现有游标和会话证明失效，不假装未结束的网络请求已经完成。

## 接线

`src/qq/qzone.cjs` 导出 `createQzone(capture,{fetchImpl})`，返回 `capabilities()/query(data,context)/action(data,context)/clear()`。

- 查询 RPC：`qzoneQuery`，operation 为 `qzone.list/detail/feeds`。
- 写 RPC：`qzoneAction`，operation 为 `qzone.publish/delete/right/like/unlike/comment/ban`。
- 所有 RPC 带当前 `expectedEpoch`；参数采用模块中显式 camelCase 字段，禁止任意服务、命令、域名、URL 或 headers。
- 能力：`qzoneRead`、`qzoneFeeds`、`qzoneWrite`、`qzoneRight`、`qzoneImages`、`qzoneUnlike`。最后一项默认 false。构造器 `enableUnverifiedUnlike` 只用于明确的协议研究/离线测试，当前生产集成不要开启。
- 无新 native 操作或回调监听器；只依赖既有 ticket 方法和可选 getPskey。
- session reset、withdrawReady、close 时调用 `clear()`。
- `src/onebot/qzone-actions.cjs` 导出 `ACTIONS/OPERATIONS/EXTENSION_REQUIREMENTS/REQUIREMENTS/runQzone`，接线时同时加入能力目录、服务分发、IPC allowlist、参数 schema，标记写操作需要副作用确认。

离线验证：`node --test tests/qzone-protocol.test.cjs tests/qzone.test.cjs`。测试包含恶意字面量、错误回执、真实空页/非空页、跨账号 Cookie、固定域名、游标完整性和会话绑定、图片实际字节、正文无损、父评论编号 0、未知写结果不重试及物理写锁。这些 fixture 验证不能替代真实空间协议验收。
