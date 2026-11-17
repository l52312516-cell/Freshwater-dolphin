# Freshwater 文档

[项目首页](../README.md) · [下载发行版](https://github.com/l52312516-cell/Freshwater-dolphin/releases) · [获取帮助](../SUPPORT.md)

首次使用可按顺序阅读：选择运行平台 → 初始化与 QQ 登录 → 连接 OneBot v11 应用 → 查询当前账号能力。

## 使用与部署

- [项目介绍与快速开始](../README.md)
- [Windows 命令行预览包](windows-runtime.md)
- [Linux / Docker 部署](linux-deployment.md)
- [管理台、QQ 登录与 OneBot v11](usage.md)
- [QQ 版本选择、切换与备份 v3](qq-runtime-management.md)
- [原生模块构建](native-build.md)
- [消息存储、恢复与专用 Docker 服务](storage-and-recovery.md)
- [邮件与 Webhook 通知](notifications.md)

## 协议与架构

- [运行结构与内部通信](architecture.md)
- [能力边界](capability-limits.md)
- [能力矩阵](reference/capability-matrix.md)及 [JSON 目录](reference/capability-matrix.json)
- [资料互动及群文件查询](query-extensions.md)
- [新增 QQAPI 只读扩展及分页边界](qqapi-extensions.md)
- [历史消息分页](history-pagination.md)
- [消息兼容、部分内容与结构化日志](message-compatibility.md)

能力矩阵是源码清单，`implemented` 表示存在实现；实际账号的 `available` 必须通过 `get_capabilities` 查询。目录不将未验证的 QQ 方法或参数变体标为真实业务通过。

## QQAPI 扩展专题

- [扩展批次与真实验证范围](qqapi-expansion-20261116.md)
- [已有接口参数与返回契约核对](original-actions-contract-audit.md)
- [群管理、待办及匿名接口边界](group-admin-evidence-20261116.md)
- [群扩展查询、签到与待办列表](query2-extensions.md)
- [联系人、翻译、申请与过滤通知](contact-extra-extensions.md)
- [收藏表情及目录修改](custom-face.md)
- [群相册及媒体上传](group-album.md)
- [QQ 空间与好友动态](qzone.md)
- [好友个性装扮](friend-dress.md)
- [闪传与部分上传恢复](flash-transfer-extensions.md)
- [文件与流式传输](file-stream-extensions.md)
- [转发资源上传与消息回应汇总限制](forward-extra.md)
- [AI 群语音与原消息转写](voice-extra.md)

## 验证与发布

- [0.2.0-alpha.3 验证摘要](releases/0.2.0-alpha.3.md)
- [0.2.0-alpha.2 发布说明与验证摘要](releases/0.2.0-alpha.2.md)
- [原生 rkey、文件及合并读取验收](native-validation-20261116.md)
- [验证流程](verification.md)
- [GitHub Releases](https://github.com/l52312516-cell/Freshwater-dolphin/releases)

## 参与与维护

- [贡献指南](../CONTRIBUTING.md)与 [PR 模板](../.github/PULL_REQUEST_TEMPLATE.md)
- [问题反馈入口](https://github.com/l52312516-cell/Freshwater-dolphin/issues/new/choose)
- [AI 辅助审核](contributing-ai-review.md)
- [安全政策](../SECURITY.md)与 [支持说明](../SUPPORT.md)

完整测试记录、本地报告、登录状态、运行日志及消息映射留在工作区，不进入 Git。公开发布只包含源码、脱敏验证摘要、能力目录及无登录数据的构建镜像。

## 许可

- [项目许可证](../LICENSE)
- [第三方声明](../THIRD_PARTY_NOTICES.md)
- [依赖许可文本](third-party-licenses.txt)
- [音频组件许可](audio-codec-licenses.txt)
