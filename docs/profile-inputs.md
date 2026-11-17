# 自身资料输入与确认

公开验证范围见 [发行验证摘要](releases/0.2.0-alpha.3.md)；历史批次的内部执行记录不随源码发布。

`set_qq_profile` 支持可选的 `nickname`、`personal_note` 和整数 `sex`（0 未知、1 男、2 女）。成功返回 `data: null`。`self_id` 如提供，必须匹配当前已就绪账号；调用方绑定的会话也必须一致。

当前源码补齐了 SnowLuma 的两种输入行为：

- 没有任何资料字段时为 no-op，不派发资料修改、资料读取或 SSO。公开 action 仍先读取本地后端 status 核对当前身份；这不是一次真实资料修改的成功证明。
- 昵称允许空串和全空白字符串，保留输入，不自动 trim 或替换。QQ 如果拒绝或未回读到请求值，动作失败；不能把“接受输入”解释为 QQ 一定允许该昵称。

显式提供 `undefined`、`null` 或非字符串的昵称/签名仍拒绝；未提供字段与提供错误类型不同。昵称最多 256 UTF-8 字节，签名最多 4096 字节，两者都拒绝 NUL。这些输入边界比 SnowLuma 的宽松字符串转换更严格，不代表全部参数行为完全相同。

实际修改前读取本号原值，核对 UID 和 UIN；修改后按请求字段逐一确认真实回读，昵称和签名使用原生 setter，性别使用固定 `0x112a/2` 的字段 20009。一个请求共用十秒期限，确认时仅轮询读取，不重发 setter。组合修改先验证全部参数和能力；已经完成一部分但后续明确失败时报告部分完成，不自动回滚。未知结果和超时不能报成功。

两项输入补充属于 r16 源码，尚未部署；最终定向证据统一见 `qqapi-r16-inputs-target-final-20261117.log`（内部归档）。该日志为本地模拟验证，没有修改真实 QQ 资料。r15 的性别实现、部署与限定云验范围见正式 r15 汇总。

参考契约：`SnowLuma-latest/packages/onebot/src/actions/extended.ts` 的 `set_qq_profile` handler，以及 `packages/protocol/src/oidb-services/profile/set-profile.ts` 的无字段短路和原始字符串序列化。Freshwater 保留自己的身份、期限和真实回读要求。
