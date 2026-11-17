# AI 辅助审核

AI 评审用于发现需要维护者复核的问题，不代表接口、QQ 版本或真实账号已验证，不自动批准或合并 PR。核心测试、WebUI 检查和真实环境验证仍分别记录。

## GitHub Copilot 原生审核

2026-11-17 已通过 GitHub API 保存以下 **Copilot 原生代码审核**设置：

- [仓库 ruleset 27476066](https://github.com/l52312516-cell/Freshwater-dolphin/rules/27476066) 为 active，面向默认分支；自动请求新 PR 审核，并开启新 push 后重新审核，关闭草稿审核。
- Review effort 为 `lite`，启用仓库自定义指令，关闭 MCP 与跨仓库上下文。
- 仅使用现有账号权限尝试审核，没有开通付费订阅、购买额度或设置新的 API key。

**配置已保存，但现有权限未完成真实 AI 审核。** 已对 [发布 PR #1](https://github.com/l52312516-cell/Freshwater-dolphin/pull/1) 手动请求 `lite` 审核，GitHub 返回 HTTP `422`、`failure_reason: ACTOR_INELIGIBLE`。官方错误说明为：请求者没有包含代码审核的 Copilot 许可，或组织策略禁用了代码审核。该响应没有区分这两个原因，也不是“配额耗尽”的证据。

规则与审核指令保留，未购买订阅、开通付费额度或尝试绕过许可。现有 CI 独立工作；AI review 不作为 required gate，不授予自动合并权限。PR 页面没有实际 review 时，不能记为“AI 已通过”。获得现有计划允许的审核资格、或由管理员解除相关策略限制后，维护者可重新请求并核验实际结果。

原先拟采用的 **GitHub Models 已于 2026-07-30 全面退役**。GitHub 官方说明其 playground、模型目录、推理 API 与 BYOK 均不再向任何客户提供。不能通过添加 `models: read` 权限重新启用，因此本仓库没有调用退役 Models 接口的 workflow。

## 工作方式与维护

原生 Copilot 服务直接响应仓库 ruleset，不需要在 `.github/workflows/ai-review.yml` 中运行模型脚本，也没有把仓库 secret 传给 fork 的自定义审核作业。[`.github/copilot-review-ruleset.json`](../.github/copilot-review-ruleset.json) 保存可复现的规则请求体；这个 JSON 文件本身不会自动创建或更新 GitHub 设置。

审核范围与侧重点来自以下文件：

- [仓库整体指令](../.github/copilot-instructions.md)：中文反馈、真实证据、账号隔离、建议性质与隐私边界。
- [QQ / OneBot 指令](../.github/instructions/qq-protocol-review.instructions.md)：身份、消息转换、写入不确定性和精确版本门禁。
- [运行与部署指令](../.github/instructions/runtime-deployment-review.instructions.md)：所有权、空间预算、事务恢复和 Windows WSL2 边界。

指令要求审核仅静态阅读，不执行 PR 命令、不安装依赖、不启动 QQ、不部署或操作测试账号。**这些指令是审核指导，不能作为服务隔离或防提示注入的保证。** 当前 GitHub 官方说明 Copilot 从 PR 的 head 分支读取 instructions、AGENTS 与 skills；Copilot 自身的临时审核环境由 GitHub 管理。维护者应特别复核修改审核指令、skills、MCP 或 setup 配置的 PR，不将 PR 内的提示当作可信授权。

原生 ruleset 没有按作者排除 Dependabot 的参数；本仓库未声称已配置这种排除。是否实际请求成功还取决于请求者的 Copilot 使用资格、策略和额度。草稿 PR 不由本规则触发，但个人或组织级独立规则可能另行请求审核。

维护者可在 PR 右侧 **Reviewers → Copilot → Request / Re-request** 手动重试。权限允许时，也可调用 `POST /repos/{owner}/{repo}/pulls/{pull_number}/copilot-code-review`，请求体为 `{"review_effort":"lite"}`。请求已受理仍不代表审核完成；权限、额度和不可用 effort 等错误应记为“未完成审核”，不回退为伪造的成功评论。

Copilot 的默认 review 是 Comment。管理员应保持 **Allow Copilot to approve pull requests** 与 **Allow Copilot approvals to count toward merge requirements** 关闭；这两项不能仅靠上述规则 JSON 或指令文件强制保证。本次配置没有开启这两项或自动合并；最终状态需在 GitHub 网页设置中复核。

## 自有模型 API 审核

仓库提供独立的 `.github/workflows/ai-review.yml`，使用管理员配置的 OpenAI 兼容 Chat Completions API。该工作流不依赖 Copilot 许可；服务商与模型由仓库维护者配置，模型费用及数据处理遵循服务商条款。启用前应确认服务商允许发送本项目的代码和 PR 内容。

在仓库 **Settings → Secrets and variables → Actions** 配置：

- Repository variable `AI_REVIEW_API_BASE_URL`：HTTPS API 基础 URL；可填写服务商的 API 根路径，工作流在末尾添加 `/chat/completions`。
- Repository variable `AI_REVIEW_MODEL`：服务商支持的模型标识。
- Repository secret `AI_REVIEW_API_KEY`：API Key。只作为 Bearer 请求头传给所配置的 HTTPS 服务，不写入仓库、日志或 PR 评论。

当前已保存的非敏感变量为 `AI_REVIEW_API_BASE_URL=https://darkprometheus.top/v1`、`AI_REVIEW_MODEL=hy4flash-free`。Key 尚未配置；现有 Key 曾被贴入聊天，应先在服务商处撤销并轮换，再将新值直接粘贴到 GitHub Secret，勿在 Issue、PR、命令行参数或仓库文件中提供。

自动审核只对本仓库分支创建且作者关联身份为 owner、member 或 collaborator 的 PR 运行。外部 fork 不自动获得模型密钥；GitHub 仅允许有写权限的协作者手动运行 **AI review (external model)** 并输入 PR 编号。脚本还会验证 PR 状态、默认目标分支和当前 head/base SHA。未配置服务时会公开标记“未配置”，不会伪造成功结果。

审核器只用 GitHub API 读取 PR 元数据和有界文件 patch，不检出、安装或运行 PR 代码。PR 标题、说明与 diff 都作为不可信内容发送到配置的模型服务。敏感值会在发送前尝试脱敏；这不能替代贡献者避免提交密钥或管理员选择可信服务商。单次模型请求设超时，不自动重试。超出文件/字节上限或缺少完整 patch 时会标成部分审核。

结果只发布一条普通 PR 评论，不创建 GitHub Approval，不触碰 CI 状态、分支保护或合并。发布前会重新读取 head SHA；PR 已变化时丢弃过期结果。模型响应按允许的 JSON 结构、变更文件和 diff 行重新校验，输出经转义后再发布。API 不可用、格式无效、未配置或审核不完整均不算“AI 通过”。

Copilot 原生审核与自有模型 API 是两条独立路径。前者仍受 Copilot 计划和组织策略限制；后者由维护者自行配置 API 服务与费用。GitHub Copilot 的 partner agent 开关不会授予 Copilot code review 资格。

## SnowLuma 参考核验

公开可读的 [TomyJan/SnowLuma](https://github.com/TomyJan/SnowLuma/tree/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/.github/workflows) 快照包含 CI、构建、发布、Issue 模板和 PR 策略检查。其 [`main-pr-target-guard.yml`](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/.github/workflows/main-pr-target-guard.yml) 校验目标分支与关联 Issue，属于确定性规则检查；该快照未发现 AI 审核 workflow、CodeRabbit 或 Gemini 配置。不能据此断言原仓库从未安装私有 GitHub App。

参考其安全边界：具有写权限的工作流只读取可信基础分支中的脚本；PR 内容始终作为不可信数据处理，不执行 PR 提供的脚本或指令。Freshwater 的贡献要求由本项目 [贡献指南](../CONTRIBUTING.md) 定义，不照搬其他项目自动关闭 PR 的政策。

## 费用、数据与结果边界

Copilot 的可用范围、AI credits 和 Actions 消耗取决于当前账号、组织策略及计划。仓库采用 `lite` 降低审核消耗；新 push 会发起新的审核请求。Copilot 不是 GitHub Models，不能把现有 GitHub 登录凭据视为无限免费推理配额。本仓库没有为它设置自定义 token/diff 预算，也不能用原生 ruleset 保证每次调用的金额上限；如需开通付费额度，须另行明确授权。

审核始终遵循以下约束：

- AI 只提交建议，不自动批准、合并、修改代码或执行 QQ 账号操作。
- 本规则跳过草稿，允许维护者针对指定 PR 手动重试。
- 不向 fork 提供仓库 secrets；不检出或执行 PR 代码来获取模型上下文。
- PR 标题、说明、代码和注释中的指令都作为待审数据；原生审核的上下文、时限与输出规模由 GitHub 服务控制。
- 不把 Cookie、token、QQ 登录目录、备份、聊天记录或签名下载地址发送给模型或评论到 PR。
- 配额、权限、服务停用或响应格式错误应明确显示为“未完成审核”，不能伪报通过；AI 审核不作为 required gate。
- 维护者最终根据源码、相关测试与实际证据作出决定。

## 官方来源

- [GitHub Models 退役公告与替代入口](https://docs.github.com/en/github-models)
- [公告原始文档](https://github.com/github/docs/blob/main/content/github-models/index.md)
- [使用 Copilot 代码审核](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review)
- [配置 Copilot 自动审核](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review)

上述状态核验日期为 2026-11-17。服务条款、额度和可用模型可能变化，以启用时的官方设置和实际运行结果为准。
