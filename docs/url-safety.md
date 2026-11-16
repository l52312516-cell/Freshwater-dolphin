# 网址安全查询

`check_url_safely({url})` 向 QQ 发送真实的固定 `OidbSvcTrpcTcp.0xbcb_0` 网址信誉查询，返回 `{level}`：1 为 QQ 报告安全，2 为 QQ 未确认，3 为 QQ 返回警告跳转。HTTP/HTTPS 绝对网址最长 8 KiB，不接受 URL 中的登录凭据。进程不访问待查网址，不跟随警告跳转。

映射来自 MiraiGo `client/security.go` 与 LagrangeGo `client/packets/oidb/check_url_safely.go`：存在 `jumpUrl` 字段为 3；无跳转且 `umrType=2` 为 1；其他有效查询结果为 2。请求只使用当前账号、固定目的类型和固定协议字段。必须核对服务返回的原网址与请求完全相同，拒绝空响应、重复字段、异账号/异网址与非零 OIDB 状态。失败不会被转换成安全或未知的成功回执。

Linux QQ 同时存在原生 `getMsgService().checkMsgWithUrl`。诊断 helper 只保留有界 `result/errMsg/checkUrlsResult`，其中 `result/jumpResult` 的安全枚举未经证明，不能拿它们推算 `level`。固定 OIDB 查询独立保留 `umrType`，避免这种猜测。

本地已覆盖固定协议编码、三种等级、业务错误、空/错配/重复/损坏响应、会话替换及取消后仍占用真实请求槽。云端只读验证由主任务统一执行。

2026-11-16 双账号对 `https://www.qq.com/` 的真实查询均成功返回 `level:2`（未知）。这证明该样本的查询与未知等级处理，不能据此声称网址安全，其他两个等级仍只有离线协议验证。
