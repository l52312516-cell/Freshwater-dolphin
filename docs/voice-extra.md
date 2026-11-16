# AI 群语音与原消息转写

本模块复用 QQ 当前登录会话的原生 MSF 通道与消息回执，不提供任意命令、URL、Cookie、原生方法或 protobuf 字段的公共入口。

| OneBot 动作 | 参数 | 返回 | 会话能力 |
| --- | --- | --- | --- |
| `get_ai_record` | `group_id`、`character`、`text`、可选 `chat_type`（默认 1，0–2） | 生成语音的官方 HTTPS URL 字符串 | `aiVoiceGenerate` |
| `send_group_ai_record` | 同上 | `{message_id}`，当前账号消息仓库分配的真实 OneBot ID | `aiVoiceSend` |
| `fetch_ptt_text` | `message_id` | `{text}` | `pttText` |

`character` 必须使用 `get_ai_characters` 返回的真实角色标识。文本原样保留，UTF-8 字节上限 4096，角色标识上限 128。`self_id` 可用于绑定当前账号，不能选择其他账号。

**两个 AI 动作都会触发群内合成协议，可能直接发布群语音。** `get_ai_record` 不能作为无副作用的预览操作；真实验证只应针对已授权测试群。合成调用失败、超时或回执缺失时，语音可能已发送，不能自动重新调用动作。

QQ `3.2.35-54395` 的真实 mode 0 与 mode 1 均未通过本项目现有完整确认链；mode 1 观测到 `synthesis-body`、业务码 1。该字段的服务端语义尚未验证，参考 `FetchAiVoice.deserialize` 只读取 msgInfo、忽略 body.statusCode，因此不能仅凭码 1 断言 QQ 拒绝，也不能确认语音是否已发布。该版本的 `aiVoiceGenerate` / `aiVoiceSend` 固定为 false，`get_ai_record` / `send_group_ai_record` 在原生派发前返回 unsupported，不继续尝试合成。源码实现保留用于离线契约验证，不算该版本云验通过。原消息 `fetch_ptt_text` 使用独立的 `pttText` 能力，不因合成关闭而连带禁用。

wave4r5 正式镜像在两个账号的实时能力目录中确认这两个 AI 动作均为 `implemented:true`、`available:false`，没有继续调用合成。该能力验证不代表合成业务通过；最终批次也未新增原 PTT 转写云样本。

## 真实回执与协议

- 合成固定为 `OidbSvcTrpcTcp.0x929b_0`、UIN mode 1，与 NapCat `OidbBase.build` 的默认 reserved=1 一致；SnowLuma 参考 facade 的默认 mode 0 不沿用。目标版本的 mode 0 / mode 1 未通过记录保留，正式执行受上述版本门控。离线链仅在服务端明确返回 pending 时继续轮询，同一动作最多 30 次，始终使用同一随机非零 32 位 session ID。传输异常不重发。
- 当前实现把传输信封、合成业务与下载头的非零码作为确认链未通过；错误只附固定 `phase` 和 uint32 `business_code`，不携带服务器原文、消息、资源 ID 或包内容。不忽略尚未验证的码，不自动重试或扩大成功判断。
- 在合成前订阅既有原生消息观察；先按当前账号 UIN/UID、精确群号筛选，再按服务端真实媒体 UUID、MD5 与大小关联。字节相同但 UUID 不同不能作为回执。
- 完成前必须按真实 native message ID 回读同一条消息，确认 sendStatus=2 与正消息序号。合成回包中其他序号不能冒充 `message_id`。多个匹配消息、缓冲区溢出、原消息改变均失败。
- `send_group_ai_record` 只把这条已发送的真实原消息写入现有消息仓库，不再次调用普通发送接口。
- `get_ai_record` 固定使用群语音 `0x126e_200`、UIN mode 1、businessType=3、sceneType=2 获取官方来源。仅 HTTPS QQ 官方域名，无重定向、Cookie 或凭据；读取实际 bytes，核验完整大小、MD5 及有界 SILK V3 数据后才返回 URL。URL 可能含服务端短期访问参数，调用方应按媒体访问凭据处理。

## 原语音转写

`fetch_ptt_text` 只接受当前账号消息仓库中的实际消息 ID，并强制刷新原消息。消息必须恰有一个可定位的原生 PTT 元素；不接收任意 URL、文件路径、媒体 handle 或伪造的音频描述。

worker 再读取精确 peer/native ID/element ID，通过已有 `receiveMedia` 取得实际原语音，重新读取账号媒体缓存验证源 MD5 与大小。原消息已有非空转写文本时直接返回该文本；否则只调用一次 `msg.translatePtt2Text(nativeId, peer, originalElement)`，最多 60 次回读原消息等待文本。每次都保持 UUID、digest、大小、duration、format 不变。没有实际完成文本时明确失败，不能把 ACK 或空文本当作成功。

## 接线与生命周期

- worker：`createVoiceExtra(capture, {native, fetchImpl})` 返回 `capabilities()`、`execute(input, context)`、`clear()`。
- RPC：`voiceExtra`，operation 为 `voice.generate`、`voice.send`、`voice.text`；必须带当前 `expectedEpoch`。字段集合见 `src/qq/voice-extra.cjs` 的 `OPERATIONS`。
- MSF 固定协议：`fixedVoiceExtra` 使用 `src/qq/voice-extra-protocol.cjs` 的 `prepare` / `decode`，没有新增 push hook。
- OneBot：`runVoiceExtra`、`ACTIONS`、`EXTENSION_REQUIREMENTS`；查询能力不能将这些动作无条件标记可用。
- `clear()` 在 reset、withdrawReady、close 时调用，阻止旧会话结果穿越会话边界。最多 4 个物理在途操作；AI 共用一个写锁，同一原 PTT 共用一个转写锁。调用方超时不会提前释放仍在运行的实际原生调用占位。
- AI 总期限不超过 60 秒；转写不超过 20 秒；单次协议/下载不超过 10 秒。音频最多 10 MiB，IPC 结果最多 1.5 MiB。

## 来源与验证范围

参考 SnowLuma 2.4.2（本地快照 HEAD `5dcbfa6f297b9dd112d859c2793687f8ed4bf563`）的 `bridge/apis/extras.ts`、`protocol/oidb-services/extras/fetch-ai-voice.ts`、`protocol/oidb-services/group-file/get-group-ptt-url.ts`、`proto-defs/oidb-actions/media.ts`。原生转写调用签名参考 NapCat `NodeIKernelMsgService.ts` 与 `FetchPttText.ts`，语音 media type=3 参考其 `UploadGroupPtt.ts`。

离线验证：`node --test tests/voice-extra-protocol.test.cjs tests/voice-extra.test.cjs`，15 项覆盖固定 wire、pending/错误/重复字段、真实消息 UUID 关联、回执竞态、实际下载摘要、原 PTT 转写、超时物理锁、会话失效、OneBot 返回值校验，以及目标版本两个公共 AI 动作和直接合成入口在原生派发前拒绝、独立 PTT 能力仍可用。离线通过不能替代当前 QQ 版本的真实群语音及转写验证。
