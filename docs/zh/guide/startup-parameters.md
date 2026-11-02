# 启动参数

KBEngine 各服务器进程启动时会接受一小撮 CLI 启动参数,并读取一小撮环境变量。所有服务器进程(`machine`/`logger`/`interfaces`/`dbmgr`/`baseappmgr`/`cellappmgr`/`baseapp`/`cellapp`/`loginapp`/`bots`)都经同一个入口解析它们——`kbe/src/lib/server/kbemain.h:238` 的 `parseMainCommandArgs`。本页是这两类面的速查;每行都标了实现它的引擎源码行。

`kbcmd` 工具与 `guiconsole` 是独立工具,参数面不同(`kbcmd --clientsdk`/`--outpath`/`--getuid`;`guiconsole` 无参)——不在本服务器进程面内,所以 Kode 的启动诊断从不把 `kbcmd`/`guiconsole` 行当服务器进程启动行。

Kode 在编辑器里把这两类面接了出来(自 KBEXP-1):

- **悬浮 / 补全** —— 在 `.sh`/`.bat` 启动脚本里,悬浮已知参数或环境变量即出双语文档并附引擎源码行;输入 `--` 补 CLI 参数,输入 `KBE_`(或 `$KBE_`)补环境变量。由 `kbengine.hover.startupScript` 把关。
- **诊断** —— 只对真实服务器进程启动行检查:未知 `--参数`(拼写错)、`--cid`/`--gus` 非数字、引用 `$KBE_RES_PATH`/`$KBE_BIN_PATH`/`$KBE_ROOT` 但本文件未赋值且未 source。由 `kbengine.startupScriptDiagnostics` 把关。

每个项目的配置文件是 **`res/server/kbengine.xml`**(覆盖引擎的 `kbengine_defaults.xml`)——本引擎**没有** `engine_config.xml` 这一文件。那些 XML 的字段级悬浮走「服务配置悬浮」,不走本页。

## CLI 参数

| 参数 | 值类型 | 作用 | 源码 |
| --- | --- | --- | --- |
| `--cid=<id>` | uint64 | 组件 ID(进程唯一标识)。启动脚本常给固定值;不给则落 `-1`(自动)——`machine`/`logger` 由 UID+MAC+类型推导,其余进程向 machine 查询(`checkComponentID`) | kbe/src/lib/server/kbemain.h:250 |
| `--gus=<n>` | uint16(≤65535) | 组序号——UUID 生成器分区;同机多实例/多组部署时区分启动批次 | kbe/src/lib/server/kbemain.h:278 |
| `--hide=<n>` | int(Win32) | Win32 下隐藏控制台窗口(`>0` 隐藏;非 Win32 静默 no-op)。bat 多开实例时配 `--hide=1` | kbe/src/lib/server/kbemain.h:302 |
| `--KBE_ROOT=<dir>` | 路径 | 等同环境变量 `KBE_ROOT`,为本进程及子进程设置 | kbe/src/lib/server/kbemain.h:331 |
| `--KBE_RES_PATH=<paths>` | 冒号/分号分隔 | 等同 `KBE_RES_PATH`;须含 `kbe/res/` 以及项目的 `res/` 和 `scripts/` | kbe/src/lib/server/kbemain.h:344 |
| `--KBE_BIN_PATH=<dir>` | 路径 | 等同 `KBE_BIN_PATH`;服务器二进制所在(如 `…/kbe/bin/server/`) | kbe/src/lib/server/kbemain.h:357 |

这就是 CLI 的全集——没有 `--cidauto`;自动 ID 就是「不给 `--cid`」。

## 环境变量

| 变量 | 读/写 | 作用 | 源码 |
| --- | --- | --- | --- |
| `KBE_ROOT` | 读 | KBEngine 安装树根目录。启动脚本先 export,进程经 resmgr 读。缺失则资源解析失败 | kbe/src/lib/resmgr/resmgr.cpp:140 |
| `KBE_RES_PATH` | 读 | 资源搜索路径(多段,Linux 冒号 / Win32 分号)。缺失则引擎找不到 `kbengine.xml`/脚本,进程无法启动 | kbe/src/lib/resmgr/resmgr.cpp:141 |
| `KBE_BIN_PATH` | 读 | 服务器二进制目录。缺失则 `$KBE_BIN_PATH/<proc>` 展开为空,进程找不到 | kbe/src/lib/resmgr/resmgr.cpp:142 |
| `KBE_TIMING_METHOD` | 读 | 高精度计时方法(`rdtsc` / `gettimeofday` / `gettime`);未设走默认——一般无需改动 | kbe/src/lib/common/timestamp.cpp:102 |
| `KBE_COMPONENTID` | 写 | 组件 ID 的字符串形态——由 `setEvns` 写出,供脚本子进程读取 | kbe/src/lib/server/kbemain.h:100 |
| `KBE_BOOTIDX_GLOBAL` | 写 | 全局启动序号,写出给脚本子进程;baseapp/cellapp 再 setenv 进 Python 环境 | kbe/src/lib/server/kbemain.h:101 |
| `KBE_BOOTIDX_GROUP` | 写 | 组启动序号,写路径同上 | kbe/src/lib/server/kbemain.h:102 |
| `UID` | 读 | 用户 ID——区分多套部署(组件 ID 推导、数据库账号)。可由环境给,否则用 `getuid()` 或硬件摘要自动推导(`autoFixUserDigestUID`) | kbe/src/lib/common/platform.h:566 |
| `UUID` | 读 | 用户 ID 覆盖(Linux 上优先于 `UID`/`getuid`);设置后即作为 UID 用 | kbe/src/lib/common/platform.h:589 |

## 启动脚本链

`kbe/res/sdk_templates/server/python_assets/` 里的模板定义了脚本链;这些进程名正是 Kode 启动脚本诊断认作「服务器进程启动行」的依据:

| 脚本 | 作用 |
| --- | --- |
| `start_server.sh` / `start_server.bat` | 先清残留,再按序起 machine → logger → interfaces → dbmgr → baseappmgr → cellappmgr → baseapp → cellapp → loginapp,每进程带 `--cid` + `--gus`(bat 多实例加 `--hide=1`) |
| `start_bots.sh` / `start_bots.bat` | 起 `bots`,不带参数(ID 向 machine 查询) |
| `safe_kill.sh` / `safe_kill.bat` | 经 `kbcmd --getuid` 取 UID,再走 `cluster_controller.py` 停集群 |
| `kill_server.sh` / `kill_server.bat` | 按进程名杀(`pkill` / `taskkill`) |
| `guiconsole.bat` | 起 `guiconsole` |
