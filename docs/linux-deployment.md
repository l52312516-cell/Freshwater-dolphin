# Linux 部署

[返回首页](../README.md) · [文档导航](README.md) · [Windows 运行方式](windows-runtime.md)

适用于 Linux x64 与 Docker Engine。稳定参考为 QQ `3.2.35-54395`；其他完整构建的实验兼容与限制见 [QQ 运行版本](qq-runtime-management.md)。

## 准备 QQ 安装包

从腾讯官方渠道取得 **Linux amd64 QQ 3.2.35-54395** Debian 安装包，并独立核对预期 SHA256，保存为：

```text
work/cache/downloads/QQ.deb
work/cache/downloads/QQ.sha256
```

`QQ.sha256` 第一行格式为 `64位SHA256  QQ.deb`。版本、架构或摘要不符时账号启动会明确失败，不会自动选取最新版。各账号共享经过核验的安装包，但各自解包和准备私有程序副本。

也可用下载工具取得包：

```sh
node tools/download-qq.cjs --url '腾讯官方HTTPS安装包URL' --sha256 '独立取得的预期SHA256'
```

工具只接受受支持的官方 HTTPS 下载主机，不把同一次下载计算出的摘要当成独立可信来源。源码包和标准 Linux 构建流程不附带 QQ 安装包；Windows 离线发行包内置 Linux QQ 安装内容。各发行资产均不应包含用户登录数据，QQ 的使用条款独立适用。


## Docker 部署

在 Linux x64 服务器构建和运行。先创建私有绑定目录，允许镜像中的 UID/GID 1000 写入所需子目录：

```sh
mkdir -p work/cache/downloads work/cache/avatars work/temp work/home work/config work/data work/runtime work/accounts work/control work/logs work/state
chmod 711 work work/cache
for directory in temp home config data runtime accounts control logs state cache/avatars; do
    chown -R 1000:1000 "work/$directory"
    chmod 700 "work/$directory"
done
chown -R 1000:1000 work/cache/downloads
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml logs --tail 100
```

不要递归修改整个 `work/` 的所有者，其中可能包含 root 管理的专用 Docker 数据或 socket。容器不需要 `privileged`、`SYS_PTRACE` 或 Docker socket。QQ 为适配该容器布局使用 `--no-sandbox`，因此不能声称启用了 Electron 沙箱。

默认 Compose 发布 `4090:4090`。首次访问前请限制到自己的访问地址，并配置 HTTPS；普通 HTTP 不加密 WebUI 访问密码、扫码凭据、会话或备份密码。可在 Compose 中同时设置：

```yaml
environment:
  FWD_WEBUI_PORT: "4090"
  FWD_TLS_CERT: /workspace/work/control/tls/cert.pem
  FWD_TLS_KEY: /workspace/work/control/tls/key.pem
```

证书和私钥须在工作区内、可由 UID 1000 读取，私钥权限设为 `600`。同时提供证书与密钥；TLS 配置错误应先排障，不要自动降级为 HTTP。也可由部署方配置 HTTPS 反向代理；确认正确转发协议/来源并保持 Cookie、REST、SSE 和 OneBot WebSocket 升级请求。

如需 Docker 镜像和构建缓存也保存在本项目目录，可以使用已安装的 Docker Engine 启动专用 daemon：

```sh
bash deploy/start-docker-daemon.sh
export DOCKER_HOST="unix://$PWD/work/run/docker.sock"
export DOCKER_CONFIG="$PWD/work/cache/docker-client" BUILDX_CONFIG="$PWD/work/cache/buildx"
docker compose -f deploy/compose.yaml -f deploy/compose.host.yaml up -d --build
```

专用 daemon 的数据在 `work/docker`，不改写默认 daemon、网桥或宿主机 iptables。host 覆盖文件需要支持 `!reset` 的新版 Docker Compose，直接监听宿主机 4090；仍需部署方配置网络访问范围。不要把专用 socket 挂入容器。停止时先对同一组 Compose 文件执行 `down`，再核对 `work/run/docker.pid` 的归属后停止专用 daemon。


## 日志、健康与排障

```sh
docker compose -f deploy/compose.yaml exec freshwater-dolphin node src/manager/cli.cjs --health
docker compose -f deploy/compose.yaml logs --tail 100
```

容器健康检查只检查管理与编排存活，不要求 QQ 已登录或下游机器人已连接。账号页分别展示接入桥、会话、QQ 在线和节点连接；未知状态不会用进程存活或 WebSocket 连通代替。

诊断日志不记录 token、QQ 票据或完整聊天正文；专用消息日志按本版设置保留有界原文，仅向已认证管理员展示。QQ 原生日志仍可能含账号信息，只在工作区私有目录轮转，不直接公开。实时日志只缓存有界最近记录，不能视为完整业务事件源。

必要子进程退出时，只清理其账号组。每个账号的 `state/processes.json` 记录 Linux 进程起始时间与组归属；管理服务重启发现遗留组时先验证并处理归属，不能无条件覆盖或向重用 PID 发信号。无法确认的状态保持受阻并要求本地处理。
