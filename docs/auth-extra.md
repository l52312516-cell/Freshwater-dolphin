# 账号鉴权与数据库密钥接口

这五个接口读取当前已登录 QQ 的真实结果，沿用 OneBot 节点鉴权及账号授权。请求绑定当前 UIN、UID、会话对象和 epoch；切号、撤权、超时或原生返回不完整时失败。接口可用性分别由 `authClientKey`、`authCookies`、`authCsrf`、`authCredentials`、`databaseKey` 门控，以本账号的 `get_capabilities` 为准。

| action | 参数 | 成功 data 与含义 |
| --- | --- | --- |
| `get_clientkey` | `{}` | `{clientKey,expireTime,keyIndex}`，来自真实 `forceFetchClientKey`。到期信息与索引保留为精确十进制字符串，缺失时失败，不编造默认有效期。 |
| `get_cookies` | `{domain?}` | `{cookies}`，返回固定域认证流程获得、且核对属于当前账号的 Cookie。 |
| `get_csrf_token` | `{}` | `{token}`，使用当前账号 `qun.qq.com` 认证所得的 `skey` 计算 31 位 CSRF 值。 |
| `get_credentials` | `{domain?}` | `{cookies,token,csrf_token}`，两个 token 字段相同，取该域认证流程的业务 token。具有有效 `p_skey` 时使用域 key；与独立 `get_csrf_token` 的 `skey` 来源可能不同。 |
| `request_decrypt_key` | `{db_path}` | `{db_key}`，从本账号数据库头取得 salt，再经固定 QQ 数据库密钥请求获取真实结果。 |

各接口均可使用通用 `self_id`，但必须等于当前账号。表中以外的参数明确拒绝；不接受调用方指定认证 URL、native 方法、协议命令或 Cookie 注入。

## 固定域与凭据范围

`get_cookies`、`get_credentials` 的域白名单为 `qun.qq.com`、`web.qun.qq.com`、`qzone.qq.com`、`vip.qq.com`，省略或空字符串均采用 `qun.qq.com`。只接受这些精确域名，不接受 URL、父域 `qq.com`、任意子域或域名后缀匹配。

认证使用当前 QQ 原生票据，跳转、落地页和 Cookie 域均受各自固定认证流程限制；Cookie 按域、路径和有效期选择，并校验账号。域 key 回退只向 QQ 请求相应的固定域。最终返回仅包含接口声明的字段，不导出会话初始化对象、原生内存、完整 HTTP 响应或其他账号的数据。

这些接口的成功响应本身会向已授权调用方交付对应凭据；“不泄漏”指日志、诊断、测试报告及异常文本不记录真实 clientKey、Cookie、密钥、带凭据 URL 或底层错误原文，不能将其理解为接口只返回占位值。读取失败不会伪装为空凭据成功。

## 数据库路径与密钥范围

`request_decrypt_key` 只接受当前管理账号根目录下 `config/QQ/` 或 `home/.config/QQ/` 中的绝对 `.db` 文件路径。账号根来自管理进程提供的 `FWD_ACCOUNT_ROOT`；没有可信账号根或目标版本原生通道不可用时，该能力不可用。其他账号、工作区任意文件、符号链接及硬链接文件均不接受。

实现只读打开普通文件，校验路径解析结果及文件身份，仅读取头部 `0xaf` 字节，并从偏移 `0x2f` 提取 128 个十六进制字符的 salt。随后发送固定 `OidbSvcTrpcTcp.0xcde_2` 请求，核对命令、子命令、业务结果、字段唯一性及非空有界 key；不读取整库、不改写数据库、不执行通用 SSO 请求。

返回值是对应数据库的解密密钥，不是 QQ 通信会话密钥，也不承诺自动解密数据库、恢复消息或适用于其他数据库。当前目标环境与逐项验证证据见 [后续完善记录](qqapi-remaining-20261116.md)，不以离线样本或能力方法存在性代替真实账号验证。
