# 收藏创建

`create_collection` 接收 `rawData`（非空 UTF-8 字符串，最多 256 KiB）、`brief`（UTF-8，最多 4 KiB），使用当前登录账号作为固定作者，调用真实 Linux QQ `getCollectionService().createNewCollectionItem`。不接受作者、文件路径、远程目标、富媒体附件数组或任意原生参数。`rawData` 是 QQ 富媒体收藏的原始字符串，按调用者提供的内容提交，不替调用者拼造收藏格式。

成功返回原生业务回执 `{ "result": 0, "errMsg": "" }`（errMsg 保留真实成功回执内容）。此回调不包含 `cid`，因此不生成收藏 ID，也不宣称已通过收藏列表回读确认。非零结果失败；无回执、断线或超时的结果可能未知，服务不自动重试。账号写锁在原生 Promise 真实完成前保持，占用不会因调用者取消或会话替换提前释放。

实现参考 NapCat `packages/napcat-core/apis/collection.ts`，并核对 Linux QQ 3.2.35-54395 `wrapper.node` 请求 converter 与 `NodeIOperateCallback` 回执 converter。原生方法存在只是运行能力，服务端仍可能因权限、版本或风控拒绝。

本轮仅本地验证固定请求、回执判定、参数边界、跨会话隔离、取消后写锁；当前云端写入授权不含创建收藏，尚未做真实账号收藏写入测试。
