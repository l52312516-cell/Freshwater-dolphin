# Freshwater 管理台

Freshwater 的浏览器管理界面：集中管理 QQ 账号、OneBot 节点、消息、日志和备份。界面由管理服务同源提供，无需单独启动前端开发服务器。

**默认地址：http://127.0.0.1:4090/** · [Windows 运行指南](../docs/windows-runtime.md) · [项目说明](../README.md)

## 使用管理台

1. 启动 Freshwater。Windows 用户运行发行包的 `Freshwater.cmd`，保持该终端开启。
2. 首次访问时，使用一次性初始化凭据设置至少 **12 位**管理台访问密码。Windows 启动器会在当前终端显示该凭据；普通部署从实例私有运行目录读取初始化凭据。Windows 的运行数据在 WSL VHDX 内，不要求用户在解压目录查找同名文件。
3. 添加或选择 QQ 账号，点击「打开远程登录」，在该账号的官方 QQ 窗口中完成登录。
4. 在「连接节点」配置 OneBot v11 对接。多个 QQ 连接任何下游框架时，每个 QQ 使用独立的机器人入口；AstrBot 只是其中一个示例。

这里的 **4090** 是 Freshwater 管理台端口，与下游机器人框架的 WebUI 端口无关。初始化凭据只用于首次设置；之后使用管理台访问密码登录，没有“首个访问者直接注册”的流程。

Windows Alpha 会先核验实例，升级时先提交冷快照，再激活账号。如果激活请求超时，账号是否已经启动可能未知；启动器会尝试停止并核验，已提交数据不会自动回滚。遇到停止未确认时保留运行目录并查看终端错误，详见 [更新与恢复](../docs/windows-runtime.md#更新与恢复边界)。

HTTP 不加密密码、会话或备份口令。Windows 发行包默认只通过本机回环访问；其他部署需要公网访问时应配置 TLS。证书和私钥通过 `FWD_TLS_CERT`、`FWD_TLS_KEY` 指向当前工作区的私有文件，二者必须同时设置。

## 前端开发

界面采用 Vue 3 / TypeScript / Vite；管理服务同源提供静态文件、REST 和 SSE。在项目根目录设置临时与缓存路径，再构建：

```sh
export TEMP="$PWD/work/temp" TMP="$PWD/work/temp" TMPDIR="$PWD/work/temp"
export npm_config_cache="$PWD/work/cache/npm"
cd webui
npm ci --ignore-scripts
npm run build
node scripts/style-audit.cjs   # 死选择器 / 过小字号 / 硬编码色值体检
```

## 信息架构

一级导航为 6 项：运行总览、QQ 账号、连接节点、**好友与消息**、运行日志、**系统设置**。

- 好友与群、消息测试合并为「好友与消息」一页的两个页内标签，共用当前账号选择器。
- 备份恢复并入「系统设置」，与外观、运行与访问、WebUI 访问密码、关于并列；切到该分区时才读取备份列表。
- 顶栏「访问密码」按钮直接打开密码设置分区；该密码用于进入面板，修改后需重新登录。
- 连接节点保留账号栏与五类标签（通用 / HTTP API / HTTP 客户端 / WS 服务端 / WS 客户端）。

## 主题与外观

界面以「夜海 · 月华」插画为配色母题，提供两套主题与可切换强调色，全部立即生效并保存在当前浏览器：

| 项 | 取值 | 存储键 |
| --- | --- | --- |
| 显示模式 | 深色「夜潮」（默认）/ 浅色「月白」/ 跟随系统 | `freshwater:theme-mode` |
| 强调色 | 潮汐青（默认）/ 月华金 / 星云紫 / 深潮蓝 | `freshwater:theme-accent` |
| 深色强度 | 柔和（默认）/ 纯黑（OLED，仅深色模式） | `freshwater:theme-contrast` |

- 主题由 `<html data-theme data-accent data-contrast>` 驱动，色值集中在 `src/styles/tokens.css`，组件样式只引用变量。
- 「跟随系统」监听 `prefers-color-scheme` 实时切换；顶栏提供三态图标控件，系统设置「外观」提供带文字的分段控件与色板。
- 切换主题会同步 `<meta name="theme-color">` 与 `color-scheme`。CSP 不允许内联脚本，首帧由默认深色承担，浅色用户可能出现一帧深色背景。

## 字体与可读性

- 字体栈：`Inter → Noto Sans SC → Noto Sans CJK SC → Source Han Sans SC → Segoe UI → 微软雅黑 UI → 苹方 → system-ui`。Linux 镜像已安装 `fonts-noto-cjk`，Windows/macOS 回落到系统中文 UI 字体。
- 正文 14px、次要信息 12px、最小字号 11px；标题使用 400/500 字重并关闭 `font-synthesis`，避免中文合成粗体发虚。
- 数字使用 `tabular-nums`；正文与次要文本在深/浅两套主题、4 套强调色下均满足对比度要求（正文 ≥ 4.5:1）。`node scripts/style-audit.cjs` 会检查字号下限、硬编码色值与无引用选择器。
- 图标统一为 `src/components/Icon.vue` 的 24×24 线性 SVG（`currentColor`、1.75 描边、38 个图标），不使用图标字体或 CDN；图标按钮的可访问名称由 `aria-label` 提供。

## 其余功能

界面提供总览、账号启停及远程登录、OneBot 节点、好友群资料、消息测试、
日志、备份恢复和 WebUI 访问密码设置。普通备份包含脱敏配置与消息 ID 映射，不含 token、QQ 票据及聊天正文；完整备份采用
独立密码且包含用户登录状态，操作时必须停止所选账号以保持一致。

账号页统一使用远程登录，移除了独立二维码面板及其后台状态轮询。账号的登录、在线和业务可用状态来自真实接入会话，不通过远程画面或进程存活推断。

“打开远程登录”按需开启内嵌 noVNC，允许手动操作所选账号的官方 QQ 登录窗口。会话绑定账号进程世代，最长五分钟，切页、切号、退出或 QQ 就绪时关闭。WebSocket 使用管理台同源路径及管理员会话，不单独开放公网 VNC 端口；禁用剪贴板同步和文件传输。断线后需手动重新打开。

“卸载注入桥”保留 QQ 程序、账号配置、登录资料与消息映射，重启此账号进入仅 QQ 模式；重新“安装注入桥”后恢复接入。“删除账号”需输入实例编号确认，停止并删除当前实例全部私有资料；其他实例不受影响。

节点页按账号和四类连接管理，编辑先写入草稿，再统一保存应用；编辑器按基础 / 连接 / 鉴权 / 行为 / 高级分区，token 与签名密钥留空保留、可显隐与复制、生成需再次确认保存，清除需明确操作。日志以时间、级别、模块及消息表格展示，支持原文、筛选、暂停、换行与自动跟随；手机宽度下每条日志转为卡片行。原文只在已认证的管理台展示，下载诊断文件排除聊天正文和对象资料；清空视图不会删除服务器日志。

## 资源来源

- `src/assets/logo.jpeg`、`src/assets/favicon.png`：项目品牌标记。
- `src/assets/login-wide.jpg`、`src/assets/login-portrait.jpg`：由项目所有者提供的插画，经 Pillow 转为 JPEG（质量 82），仅用于登录页背景与配色推导；不宣称原创，再分发时请自行确认授权。
- 界面不加载任何外部字体、图标库或 CDN 资源，符合管理服务的 CSP（`script-src 'self'; img-src 'self' data:`）。

QQ、Xvfb、DBus 与 OneBot 由每个账号的 `deploy/account-entry.sh` 监督。
账号故障只触发该实例的清理；管理服务常驻。Linux X11 自身的套接字和锁
使用系统临时 IPC 目录，日志、配置、数据与依赖缓存均在工作区。
