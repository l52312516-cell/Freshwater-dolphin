# 群匿名操作

`set_group_anonymous` 与 `set_group_anonymous_ban` 使用独立的真实协议实现。
这两条链路来自历史 OICQ / MiraiGo 协议实现，尚未在当前 QQ 版本执行群修改验证。
能力标记表示本地具备所需传输通道，不代表 QQ 服务器仍开放匿名功能。
服务端拒绝、超时、登录失败或缺少明确业务回执都会返回失败，不会兼容性返回成功。

## 群匿名开关

```json
{"action":"set_group_anonymous","params":{"group_id":123456,"enable":true}}
```

`enable` 省略时为 `true`，显式传入时必须是布尔值。
固定使用 `OidbSvc.0x568_22`，不是猜测的 TRPC 同名命令，也不使用仅改变当前会话状态的 `switchAnonymousChat`。
OIDB 请求的 command/serviceType 是 `0x568/22`，业务正文是群号 uint32 大端加一个开关字节。
不会模拟 Android 客户端版本。只有匹配命令的明确零状态 OIDB 回执，且正文符合已知空 ACK，才返回 `data: null`。

## 匿名成员禁言

```json
{"action":"set_group_anonymous_ban","params":{"group_id":123456,"anonymous_flag":"原始匿名昵称@原始匿名ID的base64","duration":1800}}
```

也支持传入原始匿名消息事件的 `anonymous` 对象，其中必须包含 `flag`；可带 `id` 和 `name`。
如果同时提供 `anonymous_flag`，两者必须一致；`name` 如果存在，也必须与 flag 中的原始昵称一致。
`id` 是事件字段，不会被当作 QQ Web 所需的二进制匿名 ID。仅有普通 QQ 号、UID 或匿名昵称不足以禁言。
匿名 ID 必须是非空、规范的标准 base64；接口不会尝试猜测、补齐或转换它。

`duration` 默认 1800 秒，可取 1 至 2592000 秒。匿名禁言不提供用 0 秒取消的语义。
请求固定 POST 至 `https://qqweb.qq.com/c/anonymoustalk/blacklist`。
表单包含原始 `anony_id/anony_nick`、群号、秒数和由 **skey** 计算的 `bkn`。
昵称及 base64 ID 均使用表单编码，保留 `+`、`=`、空格和中文等字符。
仅接受 HTTP 200 且 JSON 中明确同时存在 `retcode: 0` 和 `cgicode: 0` 的业务回执。

认证使用专门的 `qqweb.qq.com` 登录目的、精确固定落点及 Cookie 域校验。
QQ Web 的公开根路径当前返回 404，因此仅该目的的精确根落点允许 404 结束登录跳转；仍必须获得匹配当前账号的有效 Cookie，404 本身不表示认证或禁言成功。
账号必须与当前 worker 完全一致；Cookie、clientkey、skey、匿名标识和原始回包不进入日志或 API 结果。
原始 flag 目前需要调用方提供，项目尚未声称能够完整接收或生成匿名消息事件。

## 会话与重试

两项操作都绑定当前 epoch、session、QQ 号和 UID，提交前后再次检查。
每个 worker 最多四个物理在途操作；调用方超时不会提前释放仍在等待的槽位。
操作不自动重试。若提交后超时或会话改变，应先确认实际状态，再决定是否重新调用。

## 协议依据与离线验证

- OICQ `lib/group.ts` 的 `allowAnony` / `muteAnony`，以及 `lib/message/message.ts` 的原始 `name@base64(anonId)` flag。
- MiraiGo `client/builders.go` 的 `buildSetGroupAnonymous`，以及 `client/group_info.go` 的 `MuteAnonymous` 双状态校验。
- MiraiGo `client/client.go` 的 `getCSRFToken` 明确使用 skey 和初始值 5381。

`tests/anonymous.test.cjs` 覆盖字节协议、明确 ACK、拒绝伪成功、身份及 duration 边界、编码、固定登录域、会话变化、延迟结果、错误脱敏和超时后物理槽位。
这些是离线测试；没有执行群设置、匿名身份生成或成员禁言云操作。
