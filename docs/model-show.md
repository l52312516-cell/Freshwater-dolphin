# 型号展示替代协议

`_get_model_show({model})` 使用 MiraiGo `client/model_show.go` 可核对的固定 QQ VIP `13030` 查询，返回参考外层形状 `[{variants:{model_show,need_pay}}]`。列表来自服务端 `vItemList`，不回显输入生成假型号，不默认免费。

`_set_model_show({model,model_show})` 使用同一固定服务的 `13031`；空 `model_show` 表示恢复默认。只有收到对应方法 `ret=0`，以及独立业务对象 `data.rsp` 的显式零状态 `iRet` 或 `ret`，才返回 `null`，语义为服务端 ACK，不宣称其他终端已显示。历史参考忽略设置响应，因此业务回执形状仍需当前服务的写入实测；未知形状明确失败，不能只用 HTTP/网关成功代替。缺失回执、非 JSON、HTTP 跳转、非零错误均失败；超时不自动重试。

认证限定 `vip.qq.com` 的真实 p_skey，目的地固定 `https://proxy.vip.qq.com/cgi-bin/srfentry.fcgi`，不接受调用方 URL，不记录票据、Cookie 或完整请求 URL。Linux QQ 没有 Android IMEI，请求 `sIMei` 明确为空，不构造虚假移动设备身份；旧 VIP 服务可能拒绝或停用，因此源码实现与当前版本实测可用性分别记录。资料写入未纳入本轮云端写测授权，不实际执行设置。

2026-11-16，两个既有云端账号查询 `iPhone 15`，均从真实服务取得 6 个选项。该结果只验证查询；设置请求的业务回执仍未进行真实写入验证。
