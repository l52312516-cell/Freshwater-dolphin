# 消息存储与宿主恢复

## 增量消息映射

消息映射仍使用账号专属 `data/QQ号.json`。新版本兼容旧 v1 快照，不重新分配既有 ID；每次更新先追加带 SHA256 校验的 `QQ号.json.wal` 并 fsync，随后发布内存状态。近期记录最多一万条，历史定位符继续保留，避免 ID 被重复使用。

正常关闭、达到日志阈值或受控备份时执行 checkpoint：写入并同步新快照、原子替换、同步父目录，再清理 WAL。启动会重放已提交记录；仅忽略未完成的尾记录，完整记录损坏时停止写入。写入结果不明后必须重启并核实磁盘，不能继续分配 ID。

备份必须同时保留快照和 WAL，或先撤销业务授权、等待在途动作及事件转换结束、确认全部账号写进程已停止，再调用 `checkpointDirectory(data目录)`。不要在运行中的账号目录调用 checkpoint。诊断程序应使用 `MessageStore({readOnly:true})`，不会创建目录、修复尾记录或写入快照；读到 checkpoint 轮换中的不一致应重试。

回滚到不认识 WAL 的旧镜像前，先停止账号写进程，用新版本 checkpoint 后再切换。直接删除 WAL 或直接启动旧镜像可能造成 ID 回退。普通管理备份仍按隐私策略剥除聊天原文、秘密和运行元数据，恢复后节点禁用。

## 专用 Docker 的开机恢复

项目提供 `deploy/docker-daemon.sh` 及 `deploy/freshwater-docker.service`。服务文件使用 `/opt/freshwater-dolphin`；其他路径部署须先调整其中的路径。Docker 二进制须位于 `runtime/docker/`。脚本将 daemon 数据、执行状态、缓存、临时目录与日志留在工作区。

首次从手动 daemon 切换时，先检查 PID 对应的可执行文件和完整启动参数，确认它管理本工作区 socket/data-root，再受控停止旧 daemon。不得根据遗留 pidfile 杀死未知进程。完成切换后由管理员执行：

```sh
systemctl link /opt/freshwater-dolphin/deploy/freshwater-docker.service
systemctl enable --now freshwater-docker.service
```

系统仅保存服务链接，真实 unit、日志和 Docker 数据仍在项目内。容器需要配置 `unless-stopped`；人工停止的容器不会因为 daemon 恢复而自动启动。daemon 重启测试与整机重启测试分别记录，不能相互替代。

## 存储预算

当前云端文件预算为 35 GB。构建、媒体下载和备份前后核对总磁盘与项目占用，计入镜像层、暂存以及必要回滚副本。不要多次导出巨大镜像；优先移除已确认无引用的构建暂存与缓存。QQ 登录数据、消息映射及唯一可用回滚镜像不属于可随意清理内容。

基础 Ubuntu 镜像按 digest 固定，Node 与原生源码/二进制分别校验；镜像内 `runtime/apt-packages.txt` 记录实际 Debian 包版本。APT 仓库本身未固定到时间快照，因此此构建不能宣称位级可复现。
