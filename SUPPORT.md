# 获取帮助

先查看 [文档导航](docs/README.md)、[能力边界](docs/capability-limits.md)、[QQ 运行版本与备份](docs/qq-runtime-management.md) 和 [Windows 运行说明](docs/windows-runtime.md)。已知问题可在 [Issues](https://github.com/l52312516-cell/Freshwater-dolphin/issues) 搜索。

## 选择反馈入口

| 情况 | 入口 |
| --- | --- |
| 可复现错误、消息缺失、接口异常 | [问题反馈](https://github.com/l52312516-cell/Freshwater-dolphin/issues/new?template=bug_report.yml) |
| 新 QQ build、Windows / Linux 或下游兼容结果 | [兼容性报告](https://github.com/l52312516-cell/Freshwater-dolphin/issues/new?template=compatibility_report.yml) |
| 新接口或使用方式改进 | [功能建议](https://github.com/l52312516-cell/Freshwater-dolphin/issues/new?template=feature_request.yml) |
| 安全漏洞或私密数据泄漏 | [安全说明](SECURITY.md)，不要公开详情 |

请提供 Freshwater 版本、宿主系统、实际 QQ 平台及精确 build、运行方式、最小复现与相关脱敏日志。OneBot v11 下游问题还需框架、适配器和插件版本，以及账号 A / B 到各入口的路由关系。无需公开真实 QQ 号、群号、IP、密码、Cookie 或 token。

## 常见现象

| 现象 | 建议先核对 |
| --- | --- |
| 消息出现文字占位或 WARN | 查看 `_freshwater.content_status`、`reason` 与 `traceId`；这可能表示部分片段不可读取，详见 [消息兼容](docs/message-compatibility.md) |
| API 已实现但返回不支持 | 查看当前账号的 `get_capabilities`、精确 QQ build、runtime profile 和验证范围 |
| QQ 进程存在但账号不可调用 | 查看管理台身份、登录、就绪与授权状态；进程存活不等于登录完成 |
| 多账号下游消息或引用混乱 | 核对每个 QQ 的独立机器人入口与路由，保留两个账号的对应关系 |
| 超时后不知道消息是否发出 | 先检查实际收件与服务日志；不要自动重试结果不明的写入 |
| Windows 管理台打不开 | 运行 `Freshwater.cmd doctor` 与 `status`，核对 WSL 状态、磁盘空间和实例身份握手；便携包运行的是 Linux QQ |
| 升级、恢复或停止未确认 | 保留工作目录与恢复日志；不要删除 VHDX、登录目录或通过全局清理命令处理 |

只提交复现时间附近的必要片段。管理台导出的脱敏诊断也应再次检查；截图注意遮挡二维码、账号、昵称和聊天正文。不要上传 `work/`、QQ 数据库、完整备份、带签名下载 URL 或原始登录文件。

本项目没有在此公布官方支持群、即时聊天账号或商业支持承诺。Issue 中的诊断建议与 AI 辅助意见需结合实际环境判断，不能替代真实业务验证。
