# Windows 运行指南

从终端启动，在浏览器管理。Windows 发行包内置 Node 22、精简 Alpine WSL2 根文件系统、Docker Engine 和 Freshwater 运行镜像，无需另装 Docker Desktop 或 Ubuntu WSL。

> **Alpha 预览版**：这是 Windows 上运行 Linux QQ 的方案，不是原生 Windows QQ 9.9x 适配器。自动化测试覆盖了启动器、文件路径、回环认证和恢复流程；发布前未完成真实 Windows WSL 安装与 QQ 登录的端到端验收。

## 第一次运行

1. 下载完整 Windows ZIP 及同名 `.sha256`，核对文件哈希后，解压到空间充足的本地 NTFS 目录。保留整个发行包目录结构。
2. 在该目录打开终端，运行下面的命令。安装器先展示空间预算、Windows 功能及 `.wslconfig` 变更；确认内容后输入 `INSTALL`。
3. 若提示启用 Windows 功能，请按提示使用管理员终端，并在需要时自行重启 Windows，再运行相同命令。
4. 等待终端显示管理台地址。浏览器会自动打开；首次初始化凭据仅显示在当前终端，用它设置至少 12 位管理台访问密码。
5. 在管理台添加 QQ 账号，通过「打开远程登录」操作该账号的官方 QQ 窗口。保持启动终端运行。

```bat
Freshwater.cmd
```

默认地址是 **http://127.0.0.1:4090/**。首次访问凭据和后续管理台密码是两回事；不要公开终端中的初始化凭据，也不要上传运行后生成的 `work/` 或完整备份。

## 日常命令

| 命令 | 用途 |
| --- | --- |
| `Freshwater.cmd` 或 `Freshwater.cmd start` | 在前台启动，并打开浏览器 |
| `Freshwater.cmd start --no-open` | 启动但不自动打开浏览器 |
| `Freshwater.cmd status` | 查询实例及回环连接状态 |
| `Freshwater.cmd open` | 验证已有实例后打开管理台 |
| `Freshwater.cmd stop` | 优雅停止本项目实例 |
| `Freshwater.cmd doctor` | 检查运行条件和空间预算 |
| `Freshwater.cmd install` | 展示并确认安装或更新准备 |
| `Freshwater.cmd start --previous` | 按恢复提示启动缓存的旧镜像 |

`--no-browser` 是 `--no-open` 的兼容别名。`--previous` 用于明确恢复后的旧版本启动，不表示任意版本切换。

`Ctrl+C` 和 `stop` 执行幂等停止，容器给 QQ 与管理台最多 95 秒退出时间，再停止本发行版的 Docker。终端需要保持运行。直接关闭窗口可能造成非正常断开，guest supervisor 通过 stdin EOF 与 20 秒心跳租约停止本项目；不能保证 Windows 强制结束进程时回调一定执行。下次启动在实例身份和进程归属校验后恢复中断状态。首版没有托盘、后台服务或系统启动项。

Docker 命令均有有限超时，停止后再次确认容器与受管 daemon 状态。95 秒是容器宽限，后续核验和并发停止锁等待另有有限预算；无法确认时返回失败并保留诊断，不打印停止成功。重复 `start` 对已有实例重新进行回环认证后仅显示地址或打开浏览器，不创建第二个 supervisor。

## 安装与空间

启动器要求 Windows x64 build 19044 及以上、硬件虚拟化与 SLAT。这是检查基线，不代表所有 Windows 版本与 WSL 内核组合均已实测。Node 固定使用发行包内 22.x。WSL 内核必须满足此发行包固定 Docker Engine 的 cgroup2、overlay2 和网络依赖；旧内核不满足时明确报错，需要先更新 WSL。不使用膨胀空间的 vfs 回退，也不要求 systemd。

QQ 使用容器内的 Ubuntu 运行依赖，Alpine 只负责 Docker 宿主，两者共享 WSL Linux 内核。Windows 离线二进制包包含 Linux QQ 安装内容；源码包不包含 QQ 安装包。QQ、商标及服务条款属于腾讯，适用其独立条款；本项目不声称获得腾讯授权，也不是腾讯官方发行或支持的适配器。组件许可和来源见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

所有本项目运行文件位于项目 `work/windows/`：

| 路径 | 内容 |
| --- | --- |
| `distro/ext4.vhdx` | Alpine、Docker 镜像、QQ 双账号数据、guest 日志 |
| `swap.vhdx` | 明确配置到项目盘的 WSL 交换文件 |
| `private/state.json` | 实例身份及独立握手密钥 |
| `private/guest.env` | 传入专属 guest 的私有配置 |
| `private/backups/` | 合并前 `.wslconfig` 原始字节备份 |

Windows 启动器的临时目录为 `work/temp/`，缓存为 `work/cache/`。发行包提供本地 rootfs 和镜像归档，安装器不在线 `apk add`、拉取镜像或下载 QQ。导入包内 Alpine 已含固定 Docker Engine、CLI、Compose，以及 `flock`、`timeout` 等 supervisor 依赖；guest supervisor 保留前台 Docker 进程和宿主心跳。

整个 `work/windows/`（包括 VHDX、swap、凭据和备份）使用限制为当前 Windows 用户及 SYSTEM 的 NTFS ACL，防止其他本机用户直接复制虚拟磁盘读取 QQ 登录态。发行根目录、祖先目录和工作目录中存在 junction、符号链接或重解析重定向时拒绝启动，且在创建临时目录之前检查。

安装预检使用 Windows 项目卷实际剩余空间，预算为 rootfs 展开、新镜像展开、swap、账号数据预算和至少 5 GiB 安全余量。已经存在的归档不会重复计算；更新保留旧镜像及原账号数据，因此新镜像所需空间仍要额外预留。不能根据 WSL `df` 显示的虚拟磁盘最大容量判断物理盘足够。项目目录应在本地 NTFS 卷上，避免压缩、EFS 加密、符号链接或目录联接。开始运行前剩余低于 2 GiB 时拒绝启动。

唯一已说明的项目外配置例外是当前用户的 `.wslconfig`：展示后备份并合并 `[wsl2]` 的 `memory`、`processors`、`swap`、`swapFile`，其他键和段保留，支持 UTF-8/UTF-16LE BOM。默认 WSL 内存 6144 MB、容器 4096 MB、4 个处理器、swap 2048 MB。这些限制影响当前用户其他 WSL2 发行版；安装前要求用户自行停止已运行发行版，启动器不全局关闭 WSL。重复配置段、重复键或不识别的编码先报错，不猜测覆盖。

Windows/WSL 自身的安装组件、注册信息和系统临时文件仍可能写入 C 盘，本项目不承诺系统零 C 盘写入。系统盘仍须为 Windows 功能安装、更新和临时数据保留空间；预检最低余量不代表 Windows 一定能够完成组件安装。

## 网络与认证

Docker 仅发布 guest `127.0.0.1:<hostPort>:<guestPort>`，不发布所有网卡，不开放 Docker 2375/TCP。Windows 通过 WSL2 NAT 的 localhost 转发访问。端口被其他程序占用时会在启动前报错；启动仍须完成实例身份握手，只有端口有 HTTP 响应不算通过。

QQ 账号先保持延迟启动。新镜像完成身份握手和冷快照提交后，启动器才发送实例认证的激活请求。**激活失败或超时可能意味着结果未知**：请求可能已启动账号而响应未返回。此时启动器尝试停止并核验实例；停止也无法确认时会明确报错。提交之后绝不自动恢复旧数据，避免覆盖可能产生的新 QQ 数据。升级待验证期间，`open` 和第二个 `start` 不会提前激活账号。

`GET /api/runtime/instance` 使用独立的 `Authorization: Bearer` 令牌，只返回 `{instanceId,releaseVersion}`，不替代管理台原有设置口令、管理员登录、会话和 CSRF。令牌不会放在浏览器 URL、控制台输出或进程命令行中。

首次尚未初始化时，启动器通过固定 guest 命令读取原有 `setup-token.txt`，仅显示到当前终端，不进入常规日志、浏览器 URL 或额外 Windows 凭据副本。初始化后沿用管理台删除该文件的行为。

如果已有 `.wslconfig` 指定 `localhostForwarding=false`，保留原配置并拒绝运行，提示用户明确启用后重试。没有自动 `netsh portproxy`、网卡监听或 eth0 直连回退。每个 QQ 账号独立配置 OneBot/AstrBot 连接；更新保留已有节点和每账号数据，一个容器管理多个独立 QQ 进程。多个 QQ 对接 AstrBot 时，建议每个 QQ 配置独立机器人入口。

## 更新与恢复边界

先停止实例并妥善保存备份，再在同一目录覆盖完整新发行包，保留 `work/`，运行 `install`/`start`。安装器重新校验资产、预检空间和展示设置。镜像身份改变时，guest 会在停止确认后保存完整 `work/` 与旧 `runtime.env` 冷快照；宿主也会按实际数据大小检查物理盘空间。新镜像通过回环握手后才提交快照并激活账号。

提交前发生故障时，启动器先确认停止，再恢复旧程序配置和数据，并保持停止；按提示使用 `start --previous`。停止无法确认时禁止自动回滚。已提交后不自动回滚，即使激活响应丢失也一样。不要通过手工替换 `runtime.env` 或覆盖数据来处理未知结果；保留错误和运行目录供诊断。账号数据不跟随容器删除，旧镜像不会由全局 prune 清理。

镜像更新要求发行版 rootfs SHA-256 与已安装记录一致；rootfs 发生变化时明确拒绝自动替换，需要单独迁移现有 VHDX。安装记录保留 planned/imported/owned/ready 阶段；中断后无法核验实例标记时保留目录并提示人工恢复。同名发行版的归属在修改宿主配置前核实。若此次共享 WSL 配置有变化且核验曾启动已有 WSL VM，会要求重启 Windows 后继续，以保证新资源限制生效。

不把 `wsl --unregister` 当停止，不执行全局 `wsl --shutdown`。已有同名发行版若缺少匹配实例标记会被拒绝，不覆盖、不删除、不自动收养。安装中断保留现场，必要时人工核实，不自动删除 VHDX。

## 发行 manifest

根目录 `release-manifest.json` 的 `schemaVersion` 为 1，必须给出：

- `releaseVersion`、`platform: "windows-x64"`。
- `node`：固定 22.x 版本、`path`、`sha256`、`sizeBytes`。
- `alpine`：固定版本、`architecture: "x86_64"`、`dockerVersion`、`composeVersion`，以及 `rootfs` 的本地路径、SHA-256、归档字节数、`expandedBytes`。
- `image`：`reference`、完整 `sha256:` image config digest `id`、离线 `archive` 路径/哈希/字节数、`expandedBytes`。
- `runtime`：专属 `distroName`、`containerName`、`hostPort`、`guestPort`、`memoryMiB`、`wslMemoryMiB`、`processors`、`swapMiB`、`dataBudgetBytes`、固定 `stopSeconds: 95`，以及 deferred account activation 标记。
- `files`：启动器全部 CJS、guest supervisor、`.cmd` 等交付文件的相对路径、SHA-256 和字节数。

路径必须在发行包内，不允许绝对路径、越界、符号链接或目录联接。安装前校验全部资产哈希；guest 加载镜像后再次校验实际 image ID 与 manifest 相同。manifest 自身的发行可信度仍依赖交付渠道与发布校验文件，包内哈希不代替发行签名。

本地测试使用 mock WSL/Windows 命令及临时 loopback HTTP 服务，覆盖配置合并、字节备份、磁盘不足、取消安装、同名发行版保护和身份握手。通过这些测试不代表已进行真实 Windows WSL/QQ 登录验收。
