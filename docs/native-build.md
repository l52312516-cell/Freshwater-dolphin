# 原生 MSF 模块构建与部署

原生 MSF 模块从本项目 `src/native/msf-capture.c` 编译，不下载预编译扩展，也不包含 QQ 程序。当前目标固定为 Linux x64、QQ `3.2.35-54395`。构建工具和管理服务使用 Node.js 22，N-API 目标为 8；安装钩子前的 QQ 版本与函数指纹核实仍由接入层负责。

## 本机构建

在项目目录内准备 Node.js 22 和 C 编译器。官方 Node Linux x64 完整发行包自带 `include/node/node_api.h`；如果当前 Node 安装不包含头文件，请把相同版本头文件准备在本工作区内，并显式设置 `FWD_NODE_INCLUDE`，不要使用未经核实的系统版本头文件。

```sh
mkdir -p work/temp work/cache/npm work/cache/native outputs
export TEMP="$PWD/work/temp" TMP="$PWD/work/temp" TMPDIR="$PWD/work/temp"
export npm_config_cache="$PWD/work/cache/npm" XDG_CACHE_HOME="$PWD/work/cache"
node tools/build-native.cjs
node tools/build-native.cjs --verify
```

输出为 `work/native-build/msf-capture.node` 和 `manifest.json`。清单记录源码与扩展 SHA256、Linux x64、Node 版本、N-API 版本、原生响应协议版本（当前为 2）和目标 QQ 版本。编译或加载检查失败不会替换现有扩展；验证清单、源码或扩展不一致时明确失败。旧响应协议模块也会在加载检查中拒绝，不能仅保留相同文件名后直接替换部署。

## Docker 构建

`deploy/Dockerfile` 的 `native-build` 阶段使用同一份 Node.js 22 发行包中的头文件和容器内 gcc 编译。最终镜像只保留扩展及清单，路径为：

```text
/workspace/runtime/native/msf-capture.node
/workspace/runtime/native/manifest.json
```

该路径由镜像环境变量 `FWD_MSF_ADDON_PATH` 传给各个 QQ 进程。扩展位于持久化 `work/` 之外，绑定或恢复账号数据不会覆盖镜像内扩展。镜像构建和容器入口均核对 SHA256、对应源码并在独立 Node 进程中加载导出；此检查不获取 QQ 会话，也不安装钩子。检查失败时入口给出诊断并停止，避免静默运行缺少原生能力的部署。

```sh
export DOCKER_CONFIG="$PWD/work/cache/docker-client"
export BUILDX_CONFIG="$PWD/work/cache/buildx"
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d
```

首次绑定空 `work/` 时，先按 README「Docker 部署」创建并授权 UID 1000 所需的固定子目录；仅创建 `work/accounts` 不足以启动管理台。不要递归更改整个 `work/` 的所有者，专用 Docker daemon 的目录和 socket 仍归 root 管理。

升级只替换应用镜像，继续使用原 `work/` 持久化挂载。不要删除 `work/accounts`、账号登录目录或消息映射，不执行 `down -v`。登录资料和消息 ID 不属于原生模块构建产物。

普通 Node 进程的加载检查只能证明扩展格式和导出兼容；QQ 内真实调用和两个账号的业务验收另行记录。源码清单相同也不承诺不同编译器生成逐字节相同的二进制。
