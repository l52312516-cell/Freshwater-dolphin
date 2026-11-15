# Freshwater-dolphin

独立维护的 QQ kernel / OneBot v11 适配器，提供中文管理台、多个 QQ 实例与 Docker 部署。QQ 接入、内部通信、OneBot 协议及管理服务均在本仓库维护，不依赖原私有研究仓库。

**当前为实验版本。** 首批适配环境固定为 Linux x64、QQ `3.2.35-54395`、Node.js 22 或更新版本。离线测试通过、管理台可打开和 QQ 进程存活，均不能替代真实消息与接口验证；实际验证范围以 `outputs/` 内的交付报告为准。

## 运行结构

一个容器运行常驻管理服务。每个账号实例拥有独立 QQ 程序副本、Xvfb 显示、DBus 会话、HOME/XDG 目录、文件 RPC、OneBot 工作进程、消息映射和日志。默认最多同时运行两个账号；单账号退出不会主动停止其他账号。单容器内存耗尽仍可能影响整个容器，不能承诺操作系统级资源完全隔离。

管理台默认使用 **4090**，与 AstrBot 自身的 WebUI 端口 **6185** 无关。管理台提供：

- 总览：分别展示进程、QQ 接入桥、会话就绪、QQ 在线和协议连接。
- QQ 账号：创建实例、预期账号校验、启停、远程登录、安装/卸载注入桥及删除账号。
- 连接节点：HTTP API、HTTP 事件上报、正向和反向 WebSocket；编辑器按基础、连接、鉴权、行为分区，支持 token 显隐与复制。
- 好友与消息：好友与群资料查询、消息测试与 OneBot 接口调试（同一页两个标签）。
- 运行日志：按时间、级别、模块显示消息原文，支持筛选、暂停、换行、自动跟随与脱敏诊断导出。
- 系统设置：外观（深色/浅色主题、强调色）、邮件／Webhook 通知、并发账号上限、对外资源链接地址、WebUI 访问密码和备份恢复；顶栏「访问密码」可直接进入密码设置。

在「系统设置 → 通知」新增渠道，再到「连接节点 → 通用设置」选择各账号使用的渠道。默认掉线持续 30 秒后通知，恢复时再通知；正常停止和维护不触发。渠道支持独立启停、编辑、删除和确认后测试，保存即时生效。配置方法与投递边界见 [账号状态通知](docs/notifications.md)。

界面提供深色「夜潮」与浅色「月白」两套主题、4 套取自插画的强调色，以及「跟随系统」模式；偏好保存在浏览器本地。登录页使用项目所有者提供的插画作为背景，控制台本身不加载外部字体或 CDN 资源。

本项目提供协议适配与内置状态查询，不负责 LLM 或机器人插件逻辑。AstrBot 及其插件独立部署、配置与更新。

## 内置状态指令

默认在私聊或群聊中发送纯文字 `#fd`，由收到消息的账号回复 Freshwater 版本、运行平台、当前 OneBot 工作进程运行时长及真实 QQ 在线状态。运行时长在工作进程重启后重新计算，不代表 QQ 累计在线时长。

在“系统设置 → 运行与访问”中可关闭指令或自定义触发词，保存后立即生效，无需重启 QQ。触发词支持 1–32 个字符，匹配时去除首尾空白并转为小写；带有 @、引用或其他消息段的组合不触发。命中的状态指令由适配器处理，不再交给 AstrBot；关闭后按普通消息上报。

任何人均可触发，因此每账号最多每 5 秒回复一次，同一发送者每 30 秒一次；冷却期间不重复回复，发送超时不自动重发。多个账号在同一群启用时会分别回复自己的状态。

## 工作区与本地验证

所有命令从项目根目录执行，先将临时与缓存路径指向当前工作区：

```sh
mkdir -p work/temp work/cache/npm outputs
export TEMP="$PWD/work/temp" TMP="$PWD/work/temp" TMPDIR="$PWD/work/temp"
export npm_config_cache="$PWD/work/cache/npm" XDG_CACHE_HOME="$PWD/work/cache"
export DOCKER_CONFIG="$PWD/work/cache/docker-client" BUILDX_CONFIG="$PWD/work/cache/buildx"
npm ci --ignore-scripts
npm test
npm run check
cd webui
npm ci --ignore-scripts
npm run build
cd ..
```

`work/` 保存登录数据、程序副本、缓存、运行状态和日志；`outputs/` 保存交付包与报告。二者均不进入 Git。构建后的 `webui/dist/` 留在工作区，Docker 构建也会独立构建前端。不要对系统 QQ 安装目录运行入口准备工具。

Linux X11 自身的套接字和锁使用系统临时 IPC 目录；这与本项目的截图、日志、下载和缓存不同。项目生成的业务文件均位于工作区。

## 准备 QQ 安装包

从腾讯官方渠道取得 **Linux amd64 QQ 3.2.35-54395** Debian 安装包，并独立核对预期 SHA256，保存为：

```text
work/cache/downloads/QQ.deb
work/cache/downloads/QQ.sha256
```

`QQ.sha256` 第一行格式为 `64位SHA256  QQ.deb`。版本、架构或摘要不符时账号启动会明确失败，不会自动选取最新版。各账号共享经过核验的安装包，但各自解包和准备私有程序副本。

也可用下载工具取得包：

```sh
node tools/download-qq.cjs --url '腾讯官方HTTPS安装包URL' --sha256 '独立取得的预期SHA256'
```

工具只接受受支持的官方 HTTPS 下载主机，不把同一次下载计算出的摘要当成独立可信来源。源码和镜像不包含 QQ 安装内容或用户登录数据；QQ 的使用条款由腾讯提供。

## Docker 部署

在 Linux x64 服务器构建和运行。先创建私有绑定目录，允许镜像中的 UID/GID 1000 写入所需子目录：

```sh
mkdir -p work/cache/downloads work/temp work/accounts work/control work/logs work/state
chmod 711 work work/cache
for directory in temp accounts control logs state; do
    chown -R 1000:1000 "work/$directory"
    chmod 700 "work/$directory"
done
chown -R 1000:1000 work/cache/downloads
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml logs --tail 100
```

不要递归修改整个 `work/` 的所有者，其中可能包含 root 管理的专用 Docker 数据或 socket。容器不需要 `privileged`、`SYS_PTRACE` 或 Docker socket。QQ 为适配该容器布局使用 `--no-sandbox`，因此不能声称启用了 Electron 沙箱。

默认 Compose 发布 `4090:4090`。首次访问前请限制到自己的访问地址，并配置 HTTPS；普通 HTTP 不加密 WebUI 访问密码、扫码凭据、会话或备份密码。可在 Compose 中同时设置：

```yaml
environment:
  FWD_WEBUI_PORT: "4090"
  FWD_TLS_CERT: /workspace/work/control/tls/cert.pem
  FWD_TLS_KEY: /workspace/work/control/tls/key.pem
```

证书和私钥须在工作区内、可由 UID 1000 读取，私钥权限设为 `600`。同时提供证书与密钥；TLS 配置错误应先排障，不要自动降级为 HTTP。也可由部署方配置 HTTPS 反向代理；确认正确转发协议/来源并保持 Cookie、REST、SSE 和 OneBot WebSocket 升级请求。

如需 Docker 镜像和构建缓存也保存在本项目目录，可以使用已安装的 Docker Engine 启动专用 daemon：

```sh
bash deploy/start-docker-daemon.sh
export DOCKER_HOST="unix://$PWD/work/run/docker.sock"
export DOCKER_CONFIG="$PWD/work/cache/docker-client" BUILDX_CONFIG="$PWD/work/cache/buildx"
docker compose -f deploy/compose.yaml -f deploy/compose.host.yaml up -d --build
```

专用 daemon 的数据在 `work/docker`，不改写默认 daemon、网桥或宿主机 iptables。host 覆盖文件需要支持 `!reset` 的新版 Docker Compose，直接监听宿主机 4090；仍需部署方配置网络访问范围。不要把专用 socket 挂入容器。停止时先对同一组 Compose 文件执行 `down`，再核对 `work/run/docker.pid` 的归属后停止专用 daemon。

## 首次设置 WebUI 访问密码

1. 打开实际服务器的 `https://服务器地址:4090`（是否使用 HTTPS 取决于已配置的 TLS）。
2. 在服务器本地读取私有 `work/control/setup-token.txt`，填入初始化页。
3. 设置至少 12 位的独立 WebUI 访问密码。初始化成功后一次性凭据失效。

没有“第一个访问者直接成为管理员”的注册入口。管理台使用单管理员、HttpOnly 会话 Cookie、来源/CSRF 校验和登录限流。退出、改密或会话到期后需要重新登录；管理认证与 OneBot token、QQ 登录状态、备份口令分别管理。

管理认证文件损坏或丢失时应保留现场并在服务器本地修复，不要删除配置后将公网初始化页面开放给未知访问者。

## 添加 QQ 与远程登录

在“QQ 账号”页创建实例，填写备注与预期 QQ 号。启动后点击“远程登录”，管理台内嵌 noVNC 显示该账号的独立 QQ 窗口，可自行选择扫码方式、刷新官方二维码并完成手机确认。独立二维码面板、取码 API、OCR 和二维码识别依赖已经移除。

账号卡片、总览和节点列表使用已确认 QQ 身份的官方头像，通过管理后台提供并缓存十五分钟。尚未登录、身份未绑定或下载失败时显示默认文字头像，不用预填的 QQ 号假装已经登录。

远程会话按需开启，最长五分钟；切换页面、切换账号、退出管理会话、QQ 进程变化，或真实身份就绪并获管理服务授权后关闭，不自动重连。仅监听容器回环地址，通过 4090 的管理员认证及同源 WebSocket 转发；禁用剪贴板同步和文件传输。QQ 错号或未授权时仍允许打开远程登录处理。QQ 的在线、身份与业务就绪均来自真实会话，不由远程桌面连通或进程存活推断。

“卸载注入桥”恢复所选 QQ 副本的官方程序入口，保留 QQ 程序、账号配置、登录数据和消息映射。已运行账号会先等待在途动作结束、受控停止，再以无桥模式重启；此模式不运行 OneBot worker，不接受协议动作，不声称已核验 QQ 在线。点击“安装注入桥”可重新启用，运行中的实例同样需重启。入口修改前校验所有权，停止或恢复失败不伪报成功。

“删除账号”会停止并删除所选实例及其配置、QQ 副本、登录资料、消息映射与日志，必须输入该实例 ID 确认。其他账号与共享 QQ 安装包保留。删除失败时留有维护事务，不能启动该账号；“继续删除”将完成既定删除，并不是找回资料。需要保留账号资料时应先做备份。

登录后，浏览器销毁 noVNC 画布及其像素缓冲，服务端结束该会话的 x11vnc。接入桥在 QQ 确认初始化、在线且身份匹配后隐藏 QQ 窗口，并启用 Electron 后台渲染节流；QQ 离线或会话失效时恢复窗口。QQ 主进程、native 会话、Xvfb 和 DBus 保持运行。该优化减少界面工作，不保证固定内存降幅；设置进程环境变量 `FWD_QQ_BACKGROUND_MODE=off` 可关闭 QQ 窗口优化。

账号状态、日志及登录资料均为私有文件，不要上传到公开 Issue。账号故障采用有限重试，手动停止或维护中的账号不无条件自动拉起。

## OneBot 节点与 AstrBot

每个账号可配置多个独立节点。对外地址统一挂在管理服务端口，不需要为每个账号开放额外端口：

| 节点类型 | 用途 | 地址 |
| --- | --- | --- |
| HTTP API | 下游调用动作 | `https://服务器:4090/onebot/账号实例ID/节点ID/动作名` |
| HTTP 事件上报 | 主动向下游 POST 事件 | 填写下游的 HTTP(S) 事件接收地址 |
| 正向 WebSocket | 下游连接本服务 | `wss://服务器:4090/onebot/账号实例ID/节点ID` |
| 反向 WebSocket | 本服务连接下游 | 填写 AstrBot 等下游的 WS(S) 监听地址 |

实例 ID 是管理台显示的实例编号，不是 QQ 号。WebSocket 节点支持 `Universal`、`Api`、`Event` 角色；首次对接 AstrBot 建议 `Universal`。拆分 API/Event 连接时，按相应接入约定使用 `/api`、`/event` 路径和相同账号身份。

公网 HTTP API / 正向 WS 节点必须设置独立 token。节点验证自己的 OneBot token，不接受管理员 Cookie 代替节点凭据；HTTP 事件上报的可选 HMAC 签名密钥单独配置。默认关闭 HTTP quick operations，只有明确启用和验证后才允许事件响应执行操作。

在 AstrBot 添加 **OneBot v11 / aiocqhttp** 平台，开启反向 WS 监听，填写相同 token。将节点连接地址设为例如 `ws://astrbot:6199/ws`，其中端口、路径和主机以实际部署为准。普通容器网络中的 `127.0.0.1` 指本容器，不能代替另一个容器或宿主机；同一宿主机的 host 网络才可按实际监听地址使用回环。

身份未确认或会话未就绪时不会以假的 `X-Self-ID` 建立连接。心跳默认 30 秒、普通动作超时默认 10 秒、媒体动作默认 60 秒，重连退避最高 30 秒。网络中断不自动重发发送动作；发送超时意味着投递结果可能未知。

## 消息、资料与兼容性边界

标准消息使用消息段数组，保留文字空格、换行和顺序，支持文字、@、引用及已声明的表情/媒体能力。字符串输入遵循 CQ 转义及 `auto_escape`。出站先验证完整消息，未支持的段整体拒绝；不能将带未支持媒体的入站消息截成残缺文字触发机器人回复。

消息 ID 使用账号隔离的非零 32 位 OneBot ID，持久保存原始 QQ 定位信息。引用须在当前真实会话重新定位；跨会话、未知或无法验证的引用整体报错。登录补推历史消息不冒充新消息；断线事件缓冲有数量和年龄上限，溢出记录缺口，不承诺完整补发。

好友、用户、群及成员资料取自实际查询。查询失败不是空列表成功。QQ kernel 新接口会按固定版本的方法与回调核验能力；**接口列入目录不代表当前会话可用，更不代表已真机验证。** 可调用扩展 `get_capabilities` 查询当前会话支持状态，结合交付报告判断。

补充 `send_like`、`get_group_at_all_remain`、`get_group_root_files`、`get_group_files_by_folder` 和 `get_group_file_info`。点赞仅在真实成功次数与请求次数一致时成功；群文件列表使用实际请求编号关联回调，并返回明确分页信息，不能将第一页当作完整列表。参数和限制见 [补充查询接口](docs/query-extensions.md)。历史查询支持跳过已识别系统灰条并通过会话绑定游标继续翻页，失败页不会留下部分消息 ID 映射，详见 [历史分页](docs/history-pagination.md)。新增源码接口仍需以对应云端报告确认验证范围。

支持有界本地 PNG/JPEG/GIF 图片收发及资源查询，出站也接受规范 `base64://` 图片，适配 AstrBot 的 `Image.fromBytes`。单张及一条消息内嵌图片解码总量最多 10 MiB，HTTP/WS 动作帧最多 16 MiB；事件容量保持原有上限。管理台图片上传最多 10 MiB；私聊/群文件上传最多 50 MiB。成员列表、历史、撤回、部分群管理及好友/群请求已提供实现，具体方法与验证限制见能力目录。合并转发、视频发送和文件接收仍不支持，不宣称与 NapCat 或 SnowLuma 全量兼容。调试台里发送或产生副作用的接口会再次确认，一次操作不因超时重试。

`record` 出站接受账户媒体目录内的 MP3、WAV 或 QQ SILK 文件，由普通 FFmpeg 解码为 24kHz 单声道 PCM，再使用锁定版本的 SILK WASM 编码；时长和波形取自真实音频样本。输入最大 50 MiB、时长 600 秒，超限整体拒绝，不截取歌曲冒充完整语音。FFmpeg 默认位于项目 `work/tools/ffmpeg/ffmpeg`，也可用 `FWD_FFMPEG_PATH` 指定工作区内的普通可执行文件；新建镜像自带所需工具。没有工具时 `can_send_record` 返回 false。

入站完整 SILK 语音和 MP4/WebM 视频可通过 QQ 原生下载并导出为账号签名资源，分别最多 10 MiB 和 50 MiB。检查精确消息、元素、完成回调、大小、摘要和容器，不把视频缩略图当成完整视频。资源 URL 五分钟过期，图片、语音和视频共用 1000 文件/200 MiB 配额。`get_record` 的输出格式转换尚未提供；能力及真实验证范围以本轮报告为准。

系统设置中的“对外资源链接地址”应填写 AstrBot 可访问的 HTTP(S) 管理服务地址，例如 `https://服务器域名:4090`。它用于生成受限制的签名资源链接，不要填写内网不可达地址或附带 token 的 URL。

系统设置的“全局配置”统一管理所有账号的 rkey 回退服务器和音乐卡片签名 URL。rkey 服务器最多 8 个，按顺序查询，留空禁用；音乐签名 URL 留空禁用，没有默认公共服务。音乐不配置密钥时使用默认 POST 协议；配置密钥时使用 GET，参数为 `key/url/song/singer/cover/jump/format`，校验 `code:200` 和 `data` 音乐卡片。密钥独立保存，接口仅返回是否已配置；密码框留空保留原值，明确清除后切回 POST。更换服务域名时，须重新输入密钥或明确清除，避免误把旧密钥送给新服务。

保存全局配置后账号热读取，无需重启 QQ。优先使用 QQ 原生媒体下载或已有完整 URL，缺少真实 rkey 时才访问显式配置的服务器。外部服务请求限制期限、响应大小并拒绝重定向，服务 URL 和密钥不出现在诊断摘要中。`music` 出站支持 QQ/网易云歌曲 ID 和自定义卡片。带密钥服务的歌曲 ID 先从官方接口取得真实标题、歌手、封面和匿名可播放地址，版权或会员限制明确报错；密钥不会发送给歌曲资料接口。再请求签名服务，通过绑定本账号、会话和目标的一次性凭据交给 QQ 原生发送。签名或发送失败时整体报错，不伪造成功、不降级文字、不自动重发；实际可用性取决于签名服务和当前 QQ 的真实发送验证。

多账号接入 AstrBot 时，若启用了会话白名单，每个平台实例都要分别加入，例如 `first:GroupMessage:群号` 与 `second:GroupMessage:群号`。账号收到消息而没有发起 action 时，应先检查 AstrBot 的唤醒、会话白名单和插件启用范围；`action_failed` 会记录接口名与失败阶段，避免把插件未触发误判为 QQ 发送互斥。

“存储管理”显示管理范围内的总量及各账号日志、消息历史、媒体缓存。统计受扫描预算约束，部分结果会明确标注。日志策略首次保存后启用，按总量及保留天数即刻执行，随后每 5 分钟执行一次；天数为 0 时仅按容量清理，首次使用不会自动清理旧日志。消息历史和媒体缓存仅能在账号完全停止、无维护或备份写入时清理，需要输入实例 ID 确认。历史清理保留所有 OneBot ID、原始定位和去重标记，避免 ID 重用；不会删除 QQ 登录资料、程序、账号配置或活跃 RPC。未知临时数据不猜测删除。

## 日志、健康与排障

```sh
docker compose -f deploy/compose.yaml exec freshwater-dolphin node src/manager/cli.cjs --health
docker compose -f deploy/compose.yaml logs --tail 100
```

容器健康检查只检查管理与编排存活，不要求 QQ 已登录或下游机器人已连接。账号页分别展示接入桥、会话、QQ 在线和节点连接；未知状态不会用进程存活或 WebSocket 连通代替。

诊断日志不记录 token、QQ 票据或完整聊天正文；专用消息日志按本版设置保留有界原文，仅向已认证管理员展示。QQ 原生日志仍可能含账号信息，只在工作区私有目录轮转，不直接公开。实时日志只缓存有界最近记录，不能视为完整业务事件源。

必要子进程退出时，只清理其账号组。每个账号的 `state/processes.json` 记录 Linux 进程起始时间与组归属；管理服务重启发现遗留组时先验证并处理归属，不能无条件覆盖或向重用 PID 发信号。无法确认的状态保持受阻并要求本地处理。

## 备份与恢复

两种备份都通过停止所选账号的写进程取得一致快照，其他账号继续运行：

- **普通备份**：脱敏账号/节点配置与消息 ID 定位映射，不包含 OneBot token、QQ 票据或聊天正文。恢复后节点保持禁用，重新填写凭据。
- **完整加密备份**：所选账号的 `home/`、`config/`、`data/` 用户状态及节点 token、消息映射。使用独立密码、scrypt 派生密钥与 AES-256-GCM；不保存备份密码。

完整备份不包含 QQ 程序副本、安装包、缓存、日志、媒体临时文件或管理台认证。必须独立保存备份密码，遗失后无法恢复。当前有效用户状态总量上限为 128 MiB，单文件上限 32 MiB，最多 20000 个文件；超出时明确拒绝，不截断成成功备份。

恢复先上传、解密校验与预览，再明确确认。仅允许固定的状态路径与兼容版本，拒绝路径逃逸、链接、重复条目和特殊文件；先写私有暂存，再执行可回滚的目录替换。维护事务中断时保留恢复日志，相关账号不自动启动。

**恢复成功后账号保持停止**，由你核对后手动启动；恢复登录文件不等于 QQ 会接受旧会话，可能需要重新扫码。备份成功后按原运行意图恢复，备份失败保留维护现场并显示诊断。

## 旧单账号显式迁移

不会在管理服务启动时自动移动旧账号。先停止旧 QQ、旧适配器以及管理服务，保留原 `config.json`、`work/home`、`work/config`、`work/data`，确认没有旧进程仍在写入：

```sh
FWD_LEGACY_STOPPED=1 node src/manager/cli.cjs --migrate-legacy
```

`FWD_LEGACY_STOPPED=1` 仅在确已停止后设置。迁移要求新账号登记表为空，将旧配置和用户状态复制到 `legacy` 实例，保留原数据与私有回滚记录，不继承旧 QQ 程序注入状态。迁移完成后账号保持停止；在管理台核对节点、登录状态与消息 ID 映射，再明确启动。遇到链接、未知路径或不一致状态时保留现场，不覆盖原数据。

## 交付与许可

```sh
npm run package
docker save freshwater-dolphin:0.2.0-alpha.1 -o outputs/freshwater-dolphin-linux-x64.tar
sha256sum outputs/freshwater-dolphin-linux-x64.tar > outputs/freshwater-dolphin-linux-x64.tar.sha256
```

源码包采用白名单，排除工作目录、真实配置、凭据、QQ 及 Git 历史。Docker 导出镜像不包含绑定的登录数据。更新源码、程序或镜像由部署方显式完成；管理台不自行拉取镜像，不将容器内文件变更称为镜像升级。

可选的真实 `aiocqhttp` 客户端协议测试需要工作区内 Python 虚拟环境和 `requirements-test.txt`，使用模拟 QQ 后端，不登录 QQ、不向真实对象发送消息。真实 QQ/AstrBot 测试的对象与次数须另行确认，不沿用此前单条发送授权。

本项目采用[源码可见非商业许可](LICENSE)，**不是 OSI 开源许可证**。查看、学习、非商业自托管及私下修改等权利和限制以许可证正文为准。第三方组件遵循各自许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。

## 节点与消息日志

连接节点页按账号分栏，包含通用设置、HTTP API、HTTP 客户端、WS 服务端、WS 客户端。节点可命名、编辑、启用及删除，操作先进入草稿，再统一保存应用。卡片分别展示草稿、应用结果及真实连接状态；监听已启动与已有客户端连接分开显示。token 和 HTTP 签名密钥留空保留已存值，清除需明确选择。

运行日志显示经过完整协议转换和去重的接收消息，以及 QQ 明确确认且动作期限内成功的发送消息；保留空格、换行及 @、引用、表情和媒体标记。媒体下载 URL、本地路径和原生凭据不进入消息日志。原文单独写入私有 `messages.jsonl`，单文件默认 2 MiB、最多三个轮转文件，不写容器 stdout；管理员认证后才可查看。脱敏诊断下载排除原文和昵称，“清空当前视图”只影响浏览器展示。
