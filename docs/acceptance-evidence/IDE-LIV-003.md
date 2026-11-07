# IDE-LIV-003 验收证据:真实 watcher 路径查询(面板口径 ↔ 引擎控制台逐路径一致)

- 日期:2026-11-07
- 引擎真机:imac(192.168.5.117)WSL2 Ubuntu 24.04,引擎源码树 `~/kbe-src-tree` 源码构建(ninja RC=0,内嵌 Python 3.7.17),二进制部署 `~/kbengine/kbe/bin/server/`,运行目录 `C:\work\liv-run`(WSL 视角 `/mnt/c/work/liv-run`,资产源自仓库夹具 `tests/fixtures/kbengine-demo-assets` 经 `scripts/run-demo-engine.sh` 复制覆盖)
- 进程面:10 个服务端组件 + bots 全部存活(machine/logger/interfaces/dbmgr/baseappmgr/cellappmgr/baseapp/cellapp×2/loginapp,etime 16 分钟+),MySQL 127.0.0.1:3306/kode_demo(Windows 宿主 MySQL 8.0.46,WSL mirrored 网络回环)
- 套件:`src/test/electron/suite/liveObservation.test.ts --live`(真机套件),运行机 192.168.5.188,跨机广播发现 `KODE_LIV_DISCOVERY_HOST=255.255.255.255`
- 完整原始证据(逐路径面板行/原始帧/参考侧帧):同目录 `IDE-LIV-observation-run-2026-11-07.txt`

## 1. 查询身份与路径

- 目标:cellapp1(type=5/cellapp, id=7129652375332859700, pid=491, addr=192.168.5.117:48383)
- 查询路径:`/root`(真实引擎 watcher 值目录;实测叶子直查返回空,见 §4)
- 面板口径 = `runLiveWatcherPathVerification`(与 runtimeQueryWebView 同一 queryWatcherPath 实现);参考侧 = 独立 raw socket 直接对引擎 console 通道发 queryWatcher(41002),两条实现链路分离

## 2. 面板行(引擎回包展开,证据原文摘录)

```
面板行: root/gametime kind=value value=6128
面板行: root/globalOrder kind=value value=4
面板行: root/entitiesSize kind=value value=12
面板行: root/load kind=value value=0.0013458597240969539
面板行: cprofiles kind=child
面板行: ThreadPool kind=child
```

(共 10 叶子 + 6 目录键,全量见原始证据文件)

## 3. 参考侧对账(独立实现,同路径)

```
参考侧(raw socket): type=0 path='root' keys=[] values={"gametime":6128,"globalOrder":4,...,"load":0.0013458597240969539}
LIV-003 对账: 目录键 0 条全部一致; 叶子 10 条(引擎实时计数,逐条 verdict 见证据行)
LIV-003 结论: 已测,目录键面板↔引擎参考逐路径一致
```

10 条叶子逐条 verdict=match(面板值↔参考值逐条相等,gametime/load/entitiesSize 等全部一致)。

## 4. 协议引据

`kbe/res/server/messages_fixed_defaults.xml <Cellapp::queryWatcher><id>41002`;回包 65502 `kbe/src/lib/helper/console_helper.h:11`;引擎 f85ad81(与 IDE-LIV-002 审计表咬合)。原始帧(type=0 值帧 + type=1 目录帧)全量落原始证据文件。
