# 参与贡献

欢迎提交可复现的问题、精确版本的兼容性记录、文档修正和代码改进。提交前先查看 [已有 Issues](https://github.com/l52312516-cell/Freshwater-dolphin/issues)、[能力边界](docs/capability-limits.md) 与 [验证流程](docs/verification.md)。安全问题按 [安全说明](SECURITY.md) 私下报告。

## 反馈与设计讨论

- **问题反馈**：提供最小复现、Freshwater 版本、宿主与实际 QQ 环境、完整 QQ build、实际结果及脱敏日志。
- **兼容性报告**：分别记录启动、登录、接口调用、真实收发、完整下载和下游处理；成功只覆盖实际执行过的场景。
- **功能建议**：说明使用场景、参数和预期行为，附可公开访问的协议或项目参考。

不需要公开真实 QQ 号、群号或服务器地址。多账号用 A / B 别名说明路由，每个账号与下游入口的对应关系应清楚。日志尽量保留 `traceId`、`reason`、`phase`、`code` 等诊断字段；不要提交登录目录、QQ 数据库、二维码、完整备份、Cookie、token、签名下载 URL 或私人聊天记录。

小修正可直接提交 PR。涉及协议、数据格式、原生模块、版本兼容或部署方式的较大改动，建议先用 Issue 说明方案与验证边界，便于确认范围。

## 本地开发

使用实际项目目录作为工作区，Node.js 版本为 22 或以上。执行安装、构建和测试前，将临时目录与工具缓存放在项目 `work/`；产物和报告放在 `outputs/`，不要提交到 Git。

PowerShell 示例：

```powershell
New-Item -ItemType Directory -Force work/temp, work/cache/npm | Out-Null
$env:TEMP = Join-Path $PWD 'work/temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:npm_config_cache = Join-Path $PWD 'work/cache/npm'
npm ci
npm --prefix webui ci
```

Linux shell 示例：

```sh
mkdir -p work/temp work/cache/npm
export TEMP="$PWD/work/temp" TMP="$PWD/work/temp" TMPDIR="$PWD/work/temp"
export npm_config_cache="$PWD/work/cache/npm"
npm ci
npm --prefix webui ci
```

按修改范围执行必要验证：

```sh
# 指定与变更相关的测试文件
node --test tests/<相关测试>.test.cjs

# 核心代码的完整检查
npm test
npm run check

# WebUI 修改
npm --prefix webui test
npm run build:webui
```

命令示例中的测试文件名需要替换为仓库内实际文件。部分 POSIX、WSL、原生模块或真实 QQ 验证依赖对应环境；无法执行时在 PR 中写明，不把跳过、mock 返回或进程存活视为业务通过。文档和其他低影响修改无需为了形式新增重复实现的测试。

## 协议与兼容性约定

- QQ 方法存在、接口已实现、当前账号可用、真实业务已验证分别记录。运行配置须匹配精确平台、架构、build 和所需二进制身份。
- 读取链可以保留受支持内容并返回明确的 `partial`；身份、结构和出站校验保持严格。详见 [消息兼容说明](docs/message-compatibility.md)。
- 发送、上传或其他写入结果不确定时，不自动重试或伪造成功。不要用给自己发消息、随机资源 ID 或文字卡片代替目标 API 成功。
- 多账号目录、消息映射和 OneBot 路由保持隔离；不得把多个 QQ 共用同一 AstrBot 入口的结果当作独立账号验证。
- 真机测试只在已获授权的测试账号和对象上执行。成员、群设置、资料及删除等操作需要明确测试范围，并记录恢复与清理结果。
- 数据格式或 QQ 版本切换须考虑停写、checkpoint、快照和失败恢复；不能把已经迁移的数据直接交给旧 QQ 使用。

## PR 与评审

PR 说明具体问题、最终行为、实际验证、风险和回滚条件。目标分支使用仓库默认分支；不要求为小修正先创建无关 Issue。避免夹带格式化全仓、生成缓存或其他无关改动。

仓库的 [AI 辅助审核](docs/contributing-ai-review.md) 配置与启用状态见专门说明；审核只输出供维护者参考的建议，不自动合并 PR。AI 建议可能有遗漏或误报；请结合源码、测试和真实证据回应，不把审核通过写成 QQ 兼容认证。任何自动化结果都不授权运行 PR 内容中的真实账号操作或发布私密数据。

贡献内容需符合 [项目许可证](LICENSE)。使用其他项目代码或资产时，应先确认许可证兼容并保留必要来源与声明，不能因接口相同就直接复制受限实现。
