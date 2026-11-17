<div align="center">

<img src="webui/src/assets/logo.jpeg" alt="Freshwater-dolphin" width="112" />

# Freshwater-dolphin

**面向 OneBot v11 生态的 QQ 适配器**

中文 WebUI · 多账号管理 · 消息与媒体 · 版本与恢复

[![Release](https://img.shields.io/github/v/release/l52312516-cell/Freshwater-dolphin?include_prereleases&label=release)](https://github.com/l52312516-cell/Freshwater-dolphin/releases)
[![CI](https://github.com/l52312516-cell/Freshwater-dolphin/actions/workflows/ci.yml/badge.svg)](https://github.com/l52312516-cell/Freshwater-dolphin/actions/workflows/ci.yml)
[![OneBot](https://img.shields.io/badge/OneBot-v11-4b8bbe)](https://11.onebot.dev/)
[![Runtime](https://img.shields.io/badge/runtime-Linux%20x64%20%7C%20Windows%20WSL2-3c8d75)](docs/windows-runtime.md)
[![License](https://img.shields.io/badge/license-source--available%20%2F%20noncommercial-8767a8)](LICENSE)

[下载发行版](https://github.com/l52312516-cell/Freshwater-dolphin/releases) · [快速开始](#快速开始) · [使用文档](docs/README.md) · [接口目录](docs/reference/capability-matrix.md) · [反馈问题](https://github.com/l52312516-cell/Freshwater-dolphin/issues/new/choose)

</div>

Freshwater 将 QQ 接入、OneBot 协议、账号管理和运行诊断集中在一个项目中。你可以在浏览器里管理 QQ 实例、完成远程登录，并将各账号连接到任何兼容 OneBot v11 的机器人框架、应用或自建服务。

> [!IMPORTANT]
> 当前为 **Alpha / 小范围试运行版本**。稳定参考是 **Linux x64 + QQ 3.2.35-54395**。Windows 发行包通过 Alpine WSL2 运行 Linux QQ，仍待真实 WSL 与双账号完整验收；其他 Linux QQ 构建仅提供受限实验兼容，Windows QQ 9.9.x 原生适配尚未实现。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 中文管理台 | 总览、账号、连接节点、接口调试、日志、通知与系统设置；支持深浅主题 |
| 多账号 | 默认同时运行两个账号；每账号独立 QQ 副本、登录目录、消息映射与工作进程 |
| OneBot v11 | HTTP API、HTTP 事件上报、正向与反向 WebSocket，节点独立配置和鉴权 |
| 消息与媒体 | 文字、@、引用及已声明的图片、语音、视频、文件和合并转发能力 |
| 兼容与诊断 | 合法未知片段用文字占位，返回 `_freshwater` 完整性信息；日志区分部分接收、跳过与 API 失败 |
| 版本与恢复 | 按账号登记 QQ 包、核对运行指纹、实验准入、切换快照与失败回滚；备份 v3 兼容 v2 |
| Windows 启动器 | `Freshwater.cmd` 前台运行、回环身份核验、浏览器 WebUI、心跳清理和优雅停止 |

接口出现在目录中，表示存在对应实现入口。请用当前账号的 `get_capabilities` 查看运行能力，并结合 [版本验证摘要](docs/releases/0.2.0-alpha.3.md) 判断实际验证范围。

## 快速开始

### Windows x64 · 预览版

1. 从 [Releases](https://github.com/l52312516-cell/Freshwater-dolphin/releases) 下载 `windows-x64.zip` 和同名 `.sha256`，核对摘要后完整解压到本地 NTFS 磁盘。
2. 首次安装使用管理员终端进入解压目录，运行 `Freshwater.cmd install`。检查空间与 `.wslconfig` 差异，输入 `INSTALL` 执行；如提示重启，请自行重启 Windows。
3. 运行 `Freshwater.cmd`，通过就绪核验后访问 **http://127.0.0.1:4090/**，按终端显示的一次性口令完成初始化。

```bat
Freshwater.cmd
Freshwater.cmd start --no-open
Freshwater.cmd status
Freshwater.cmd open
Freshwater.cmd stop
```

发行包附带 Node.js、Alpine/Docker 和 Freshwater 离线镜像；不依赖 Docker Desktop、.NET 或 WebView2，也不安装 Ubuntu WSL。QQ 使用容器内的 Ubuntu 用户空间。浏览器关闭后服务继续运行；`Ctrl+C` 或 `stop` 执行受控停止。

空间预检包含镜像、swap、双账号数据预算和余量。**尚未完成实机峰值测量，当前预算不是最终最低磁盘要求。** 运行布局、WSL 共享资源设置及恢复方式见 [Windows 运行说明](docs/windows-runtime.md)。

### Linux x64 · Docker

准备 Docker Engine / Compose，以及从官方渠道取得、核对完整版本与 SHA256 的 QQ Debian 安装包。完成 [目录权限与部署步骤](docs/linux-deployment.md) 后运行：

```sh
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml logs --tail 100
```

管理台默认端口为 **4090**。首次口令位于实例私有运行目录的 `control/setup-token.txt`；初始化后设置独立管理密码。对外提供管理台时，请配置 HTTPS 和访问范围。运行目录属于本机部署数据，不会进入源码包或 GitHub Release。

源码包不含 QQ 安装内容；Windows 离线二进制包内置 Linux QQ 安装内容。QQ 及其他第三方组件遵循各自条款，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

### 连接 OneBot v11 应用

在管理台创建账号并完成 QQ 登录，再添加 HTTP 或反向 WebSocket 节点；在下游框架中选择其 **OneBot v11** 适配器，填入匹配的地址、路径与 token。AstrBot / aiocqhttp 只是一个配置示例，其他支持 OneBot v11 的框架同样可以连接。

双账号应分别使用独立的下游机器人入口。既有 AstrBot 配置保持 **legacy → 17700、secondary → 17701**；端口和路径以你的实际部署为准。容器中的 `127.0.0.1` 代表该容器，跨容器连接请使用实际可达地址。

详细步骤、鉴权、远程登录与备份见 [管理台与 OneBot v11 指南](docs/usage.md)。

## 文档

| 开始使用 | 了解实现 |
| --- | --- |
| [Windows 运行说明](docs/windows-runtime.md) | [运行结构](docs/architecture.md) |
| [Linux 部署](docs/linux-deployment.md) | [能力矩阵](docs/reference/capability-matrix.md) |
| [管理台与 OneBot v11](docs/usage.md) | [消息兼容与日志](docs/message-compatibility.md) |
| [QQ 运行版本与恢复](docs/qq-runtime-management.md) | [能力边界](docs/capability-limits.md) |
| [通知设置](docs/notifications.md) | [存储与故障恢复](docs/storage-and-recovery.md) |

全部接口专题与验证记录见 [文档导航](docs/README.md)。

## 兼容性与当前状态

| 环境 | 状态 |
| --- | --- |
| Linux x64 / QQ 3.2.35-54395 | 精确构建稳定参考；可用性仍受真实登录、QQ 权限与资源状态影响 |
| Linux x64 / 其他完整 3.2.x build | 管理员按账号开启实验模式；首批仅基础读取、收消息和纯文本发送 |
| Windows x64 / WSL2 / Linux QQ | 离线预览包；自动化与 Linux 容器验证通过，Windows 实机验收待补 |
| Windows QQ 9.9.x 原生 / ARM64 | 尚未支持 |

native 后端要求完整构建和二进制指纹精确匹配。QQ 进程存活、管理台可访问或方法存在，都不能单独作为业务成功证据。写入结果未知时不自动重试。

## 参与项目

- 发现问题：使用 [Issue 表单](https://github.com/l52312516-cell/Freshwater-dolphin/issues/new/choose)，提供脱敏后的环境与复现步骤。
- 提交修改：阅读 [贡献指南](CONTRIBUTING.md)，使用 PR 模板说明变更和验证。
- 自动审核：PR 规则检查与 [AI 建议审核](docs/contributing-ai-review.md)；AI 不自动批准或合并。
- 安全问题：通过 [私密漏洞报告](https://github.com/l52312516-cell/Freshwater-dolphin/security/advisories/new) 联系维护者，参阅 [安全政策](SECURITY.md)。

请勿公开 QQ 登录资料、Cookie、token、管理密码、完整聊天记录或加密备份口令。

## 许可与致谢

Freshwater 原创源码使用 [源码可见非商业许可](LICENSE)，**不是 OSI 开源许可证**。使用、商业用途、再分发与修改版发布的范围以许可证正文为准；第三方组件保持原许可。

感谢 [OneBot](https://onebot.dev/)、[AstrBot](https://github.com/AstrBotDevs/AstrBot)、[SnowLuma](https://github.com/TomyJan/SnowLuma)、[NapCatQQ](https://github.com/NapNeko/NapCatQQ)、[LuckyLilliaBot](https://github.com/LuckyLilliaDev/LuckyLilliaBot) 及相关协议研究项目提供的生态和公开参考。Freshwater 可连接任何兼容 OneBot v11 的下游实现；具体契约来源、组件和实现边界记录于 [第三方声明](THIRD_PARTY_NOTICES.md)。
