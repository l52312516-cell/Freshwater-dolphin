# 原始 SSO 与统计

`send_packet`（别名 `.send_packet`）通过目标 Linux QQ 的真实原生发送通道，使用与固定业务请求相同的串行队列、会话验证、总超时、独立回调 ID 与释放机制。调用方须使用现有 OneBot 节点鉴权；请求只作用于该节点绑定的账号。

参数 `cmd` 为最多 127 个 ASCII 字符的命令名，允许字母、数字、下划线、点、冒号和连字符，必须以字母开头；`data` 默认空字符串，必须为偶数长度十六进制，最多 64 KiB；`rsp` 默认 `true`。`rsp=true` 返回十六进制响应正文，传输错误明确失败，响应大小沿用原生通道上限。`rsp=false` 返回 `null`，仅代表原生层确认提交，不代表 QQ 接受或完成业务。超时可能已发送，不自动重试。该接口具备当前 QQ 账号的协议操作能力，调用方应保存已验证的命令与数据配对。

`nc_get_packet_status` 返回真实聚合对象，替换参考项目的 `null` 占位值。`scope=adapter-native-sso`、`includesAllQQTraffic=false`：统计本适配器原生队列的请求，不是 QQ 全部流量；`resetScope=worker-process` 表示 QQ 桥进程重建后归零。`queued/submitted/response/succeeded/failed/cancelled/timed_out` 分别记录入队、物理提交、观测响应和调用结束，`requestBytes/responseBytes` 为字节计数；不保存命令、包内容、账号、凭据或错误正文。`succeeded` 表示适配器调用完成，`rsp=false` 的完成仍只表示提交。另返回当前排队数、是否有活动请求，以及原生安装/目标校验/存活回调数。

云端验收只发送已经验证的只读 rkey 请求并在内存中解码检查，不把响应、rkey 或凭据写进报告。
