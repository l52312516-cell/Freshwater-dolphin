# 第三方组件

Freshwater-dolphin 的原创源码适用根目录 `LICENSE`。本文件不会改变第三方组件自己的许可，也不表示取得了重新授权第三方软件的权利。

| 组件 | 版本 | 许可 / 声明 |
| --- | --- | --- |
| [ws](https://github.com/websockets/ws) | 8.23.0，由 package-lock.json 锁定 | MIT；完整文本见下文和安装目录 `node_modules/ws/LICENSE` |
| [silk-wasm](https://github.com/idranme/silk-wasm) | 3.7.1，由 package-lock.json 锁定 | 包装层 MIT；内含 libSilkCodec 的 BSD 声明、Skype SILK SDK 声明及 wav-file-decoder MIT。完整文本见 `docs/third-party-licenses.txt`；这些许可不由本项目重新授权 |
| FFmpeg | 显式配置的工作区工具或镜像构建记录中的发行版版本 | 依据实际构建选项适用 LGPL/GPL 及所启用组件各自许可。工具不从 NapCat 或 QQApi 复制；交付镜像须保留发行版版权文件和对应源码获取信息 |
| Fastify 及运行依赖 | 根 package-lock.json 锁定 | 各组件许可及完整许可证见 `docs/third-party-licenses.txt` |
| [Nodemailer](https://nodemailer.com/) | 10.5.0，由 package-lock.json 锁定 | MIT-0；用于 SMTP 通知，完整文本见 `docs/third-party-licenses.txt` |
| [noVNC](https://github.com/novnc/noVNC) | 1.7.0，webui/package-lock.json 锁定 | MPL-2.0；保留未修改的库源代码及随包 vendor 许可，见 `docs/third-party-licenses.txt`。对应源码可从 npm 的 `@novnc/novnc@1.7.0` 包取得 |
| x11vnc / LibVNCServer | 镜像内 Ubuntu 软件包版本 | GPL-2.0 及组件各自许可；完整许可及发行版源码获取说明见镜像 `/usr/share/doc/*/copyright` |
| Vue 3、Vite、TypeScript、vue-tsc 及构建依赖 | webui/package-lock.json 锁定 | Vue/Vite 为 MIT，TypeScript 为 Apache-2.0；完整许可证见 `docs/third-party-licenses.txt`；构建依赖不装入运行镜像 |
| [Node.js](https://nodejs.org/) | Docker 默认 22.23.5 | Node.js 及其附带组件许可证见发行包 `LICENSE` |
| Ubuntu 与系统依赖 | Ubuntu 22.04，具体版本由镜像构建记录确定 | 各软件包独立许可；容器 `/usr/share/doc/*/copyright` |
| 腾讯 QQ | 首批兼容 3.2.35-54395 Linux x64 | 第三方专有软件，由用户从官方渠道取得并遵守其条款；不放入本项目源码包 |
| aiocqhttp / Hypercorn / Quart / Flask | 仅可选互操作测试，版本见 requirements-test.txt | 前三者 MIT，Flask 为 BSD-3-Clause；其他间接依赖按各自许可。通过独立 Python 环境安装，不打入运行镜像 |

OneBot v11 是本项目实现的通信协议。AstrBot 是对接目标；本项目不包含 AstrBot 源码。未引入 SnowLuma、NapCat 或原私有研究仓库的实现代码。

## ws — MIT

Copyright (c) 2011 Einar Otto Stangvik &lt;einaros@gmail.com&gt;
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
