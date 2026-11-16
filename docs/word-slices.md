# 本地文本分词

`.get_word_slices({content})` 返回 `{slices:string[]}`，使用运行时 ICU 的 `Intl.Segmenter('zh-CN',{granularity:'word'})`。这是一项本地文本工具，不调用 QQ 分词服务，不传输正文，不伪造 QQ 回执。保留标点和空白，结果按顺序拼接必须严格等于输入；不同 Node/ICU 版本的词边界可能不同，不承诺复刻旧 Android QQ 的专有词典。

正文最多 64 KiB UTF-8，允许空文本，拒绝无效代理字符及未知参数。最多 65536 段；不存在 ICU 分词能力时明确失败。完成后验证原账号会话仍有效。能力 `wordSlices` 应由本地 `Intl.Segmenter` 可用性生成，不需要原生 QQ 方法或额外 RPC。

接线模块 `src/onebot/word-slices-actions.cjs` 导出 `ACTIONS/EXTENSION_REQUIREMENTS/runWordSlices`。公共参数 `content:string`、可选 `self_id`，只读动作。相关测试 `tests/word-slices-actions.test.cjs` 验证中英文、表情、空白的完整保留，闭合参数/字节预算以及会话变化。
