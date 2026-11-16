# 好友个性装扮

`_get_friend_dress({user_id})` 通过固定 `zb.vip.qq.com/v2/pages/aioDressPage` 页面读取实际装扮，返回 `{target_uin,is_svip,avatar_url,items}`。来源是 SnowLuma 2.4.2 的 `protocol/src/web/friend-dress.ts` 和 `core/src/bridge/apis/web.ts`。

独立 `vip.qq.com` Cookie 认证与账号校验，禁止拿空间或群域 Cookie 代用；凭据留在 worker。登录仅允许跳转至固定 `https://vip.qq.com/`；VIP 不存在空间式的 `/<uin>/infocenter` 页面。URL 的内外两层 target 与 chatId 均由精确 QQ 号构建，trace/移动 UA 固定。重定向、正文、总期限、物理并发占位沿用受限 QQ Web helper，但 purpose 是闭合 `friendDress` 枚举，调用者不能选任意域。总期限 15 秒、单 HTTP 10 秒、页面 2 MiB、最多四个尚未结束查询。

仅提取完整 `window.__INITIAL_ASYNCDATA__` JSON，不执行任何页面脚本。目标账号、目录和会员状态必须真实存在；认证页、风控页、改版、畸形或串号数据明确失败，不能当空装扮。剔除参考源码确认无法凭目标号返回真实值的气泡(2)、字体(5)、头像(23)。名片视频来自 `immersiveMaterial.videoUrl`；来电视频仅在已知 `(web_)image.jpg` 文件名时按源确认规则映射，不猜测其他地址。物品默认 id、空名称及零价格遵循参考页面契约；它们不代表额外商城报价验证。

接线：`src/qq/friend-dress.cjs` 的 `createFriendDress(capture,{fetchImpl})` 返回 `query/capabilities/clear`。能力 `friendDress`，RPC `friendDressQuery({targetUin,expectedEpoch})`，返回 `{uin,targetUin,result}`。session reset/withdrawReady/close 调用 `clear()`。OneBot 模块 `src/onebot/friend-dress-actions.cjs` 导出 `ACTIONS/EXTENSION_REQUIREMENTS/REQUIREMENTS/runFriendDress`。

离线测试 `node --test tests/friend-dress.test.cjs tests/qzone-web.test.cjs`。第四批双账号真实查询均在原 VIP 登录终点得到 404，历史失败保留在验收报告。修复固定根页面后，wave4r3 两个测试账号查询自身及另一已授权测试账号均通过真实装扮读取；wave4r5 正式镜像再次通过相同的四个账号/目标组合。这只覆盖已有账号样本，不代表其他用户、会员装扮类型或风控状态均已验证。公共页面 HTTP 200 本身不算已认证装扮读取成功。
