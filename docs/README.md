# 文档导航

## 使用与部署

- [项目介绍、准备 QQ 与 Docker 部署](../README.md)
- [原生模块构建](native-build.md)
- [消息存储、恢复与专用 Docker 服务](storage-and-recovery.md)
- [邮件与 Webhook 通知](notifications.md)

## 协议与架构

- [运行结构与内部通信](architecture.md)
- [能力边界](capability-limits.md)
- [能力矩阵](reference/capability-matrix.md)及 [JSON 目录](reference/capability-matrix.json)
- [资料互动及群文件查询](query-extensions.md)
- [历史消息分页](history-pagination.md)

能力矩阵是源码清单，`implemented` 表示存在实现；实际账号的 `available` 必须通过 `get_capabilities` 查询。目录不将未验证的 QQ 方法或参数变体标为真实业务通过。

## 验证与发布

- [0.2.0-alpha.2 发布说明与验证摘要](releases/0.2.0-alpha.2.md)
- [原生 rkey、文件及合并读取验收](native-validation-20261116.md)
- [验证流程](verification.md)
- [GitHub Releases](https://github.com/l52312516-cell/Freshwater-dolphin/releases)

完整测试记录、本地报告、登录状态、运行日志及消息映射留在工作区，不进入 Git。公开发布只包含源码、脱敏验证摘要、能力目录及无登录数据的构建镜像。

## 许可

- [项目许可证](../LICENSE)
- [第三方声明](../THIRD_PARTY_NOTICES.md)
- [依赖许可文本](third-party-licenses.txt)
- [音频组件许可](audio-codec-licenses.txt)
