# AI 辅助审核

本项目主要通过维护者配置的 OpenAI 兼容 API 提供 AI 审核。结果用于提示需要人工复核的问题，不代表测试、QQ 版本或真实账号业务已经验证。

## 配置自有模型 API

工作流位于 [ai-review.yml](../.github/workflows/ai-review.yml)，实现位于 [ai-review.cjs](../tools/ai-review.cjs)。使用前先确认所选服务允许处理本项目代码及 PR 内容，并了解其费用、日志和数据保留规则。

在仓库 **Settings → Secrets and variables → Actions** 中配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Repository variable | `AI_REVIEW_API_BASE_URL` | 服务商的 HTTPS API 基础 URL |
| Repository variable | `AI_REVIEW_MODEL` | 服务商支持的模型标识 |
| Repository secret | `AI_REVIEW_API_KEY` | 对应 API 密钥 |

API 采用 Chat Completions 格式；基础 URL 未以 `/chat/completions` 结尾时，脚本会添加该路径。URL 不得包含账号密码、查询参数或片段。

密钥仅配置为 GitHub Secret，不写入仓库文件、Issue、PR、命令行参数或公开日志。配置存在不代表服务可用，也不代表审核已经完成。

## 自动与手动触发

自动审核使用 `pull_request_target`，仅处理目标为 `main`、分支属于本仓库、作者关联身份为 `OWNER`、`MEMBER` 或 `COLLABORATOR` 的 PR。

外部 fork 不自动触发模型调用。具有仓库写权限的维护者可在 **Actions → AI review (external model) → Run workflow** 中选择默认分支，填写 PR 编号，明确发起一次审核。

手动入口也会检查 PR 是否仍开放、是否为草稿、是否面向默认分支，并核对当前 head/base SHA。草稿、已关闭或目标不符的 PR 不进入模型审核。

工作流和脚本必须先存在于可信默认分支。运行其他分支上的手动工作流不能用于绕过默认分支检查。

## 审核如何运行

两项作业只检出可信默认分支，不检出、安装依赖或执行 PR 中的代码，也不执行 PR 提供的命令、工作流、审核指令或工具配置。

- 审阅作业持有只读 GitHub token 和模型 Secret，通过 GitHub API 读取 PR 元数据与有界 patch。
- 发布作业持有 PR 写权限，不接收模型 Secret；仅接收经过编码的结果数据，并独立校验后发布。
- PR 标题、说明、路径和 patch 均作为不可信数据，不能构成新的执行或授权指令。

当前最多审阅 100 个文件；单文件 patch 最多 12,000 个 UTF-8 字节，总 patch 最多 180,000 字节。超过预算、二进制文件或缺少 patch 时，结果标记为部分审核。

每次运行最多发出一个模型请求，超时为 45 秒，不自动重试。超时或网络失败不说明服务端未处理请求，也不保证没有产生费用。

模型结果按允许的 JSON 字段、问题数量、文本长度、变更路径和新增行号校验；公开文字经脱敏及转义处理。格式不符时不发布模型原文。

## 如何理解结果

| 状态 | 含义 |
| --- | --- |
| `completed` | 已对本次有界输入完成审核，不等于代码通过或没有缺陷 |
| `partial` | 输入或输出不完整，需要人工补查未覆盖部分 |
| `not_configured` | 缺少配置，或 PR 不符合运行条件，未完成审核 |
| `failed` | 请求、响应校验或其他步骤失败，未完成审核 |

结果发布为普通 PR 评论，不创建 Approval，不改变 CI、分支保护或合并状态，不自动部署、修改代码、合并或操作 QQ 账号。

抓取 patch、模型返回和发布前会重新核对 head/base SHA；发现 PR 已变化时丢弃过期结果。没有评论时应查看 Actions 日志，不把静默跳过视为通过。

AI 审核不作为 required gate。维护者仍须阅读改动、复核问题，并按 [贡献指南](../CONTRIBUTING.md) 和 [验证流程](verification.md) 完成必要检查。

## 敏感数据与服务边界

PR 元数据与选定 patch 会发送到配置的外部模型服务。脚本会跳过部分敏感路径，并尝试识别密钥、令牌和签名参数；这些规则不能识别所有私密内容。

不要提交或发送 Cookie、QQ 登录目录、备份、聊天记录、真实账号资料或签名下载地址。发现泄露应先按 [安全说明](../SECURITY.md) 处理，不依赖模型过滤或删除评论补救。

默认分支隔离、权限分离和结构校验限制执行与发布范围，但不能保证模型不受提示注入影响，也不能保证模型结论正确。涉及审核脚本、工作流或指令的 PR 必须人工复核。

## 可选：GitHub Copilot 原生审核

Copilot 是独立路径，取决于现有账号权限、可用许可、组织策略和额度；本项目不承诺请求一定受理或完成。维护者可在 PR 的 **Reviewers → Copilot** 中请求审核，并检查实际结果。

- [规则请求体](../.github/copilot-review-ruleset.json)：供维护者核对或管理仓库规则；文件本身不会自动更新 GitHub 设置。
- [整体审核指令](../.github/copilot-instructions.md)、[QQ / OneBot 指令](../.github/instructions/qq-protocol-review.instructions.md)、[运行与部署指令](../.github/instructions/runtime-deployment-review.instructions.md)：说明审核侧重点，不构成隔离保证。

原生 Copilot 的上下文和执行环境由 GitHub 管理，不能套用自有 API 工作流的隔离与预算承诺。保持批准及自动合并相关设置关闭，仍由维护者判断最终结果。

GitHub Models 已退役，本项目不调用其旧推理接口；参见 [GitHub 官方说明](https://docs.github.com/en/github-models)。

Copilot 的使用方式与服务边界以 [官方代码审核文档](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review) 和 [自动审核配置文档](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review) 为准。
