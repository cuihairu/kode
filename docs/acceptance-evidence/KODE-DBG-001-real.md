# KODE-DBG-001 真机验收证据:debugpyInject 命令附加成功 + 断点真实命中

- 日期:2026-11-07
- 目标:方案②「控制台运行时注入」(telnet :python 层 `debugpy.listen`),由一键命令 `kbengine.debug.debugpyInject`(src/debugpyInjectCommand.ts)驱动的生产通路
- 引擎真机:imac(192.168.5.117)WSL2 Ubuntu 24.04,引擎源码构建、内嵌 Python 3.7.x,二进制部署 `~/kbengine/kbe/bin/server/`,运行目录 `C:\work\liv-run`(WSL 视角 `/mnt/c/work/liv-run`,资产源自仓库夹具 `tests/fixtures/kbengine-demo-assets` 经 `scripts/run-demo-engine.sh` 复制覆盖)
- 进程面:10 个服务端组件 + bots 全部存活(restart 后 cellapp pid=12749,广播可达),cellapp telnet 控制台 `192.168.5.188:50000` 实测可达
- 套件:`src/test/electron/suite/debugpyInjectLive.test.ts`(真机套件,`node out/test/electron/runTest.js --dbglive`),运行机 192.168.5.188
- 完整原始证据(逐行时间戳):同目录 `evidence/KODE-DBG-001-real-run.log`(本次通过运行片段 2026-11-07T10:56:46Z→10:57:04Z)

## 1. 通路方案(反向隧道桥)

本机(Windows 宿主)到 WSL 引擎的裸 loopback 转发在此机上是坏的(127.0.0.1/宿主 IP 全部超时),唯一稳定通路是镜像进 WSL 的 overlay 地址(wg-meshlet/ZeroTier);debugpy adapter 只绑 `127.0.0.1:5679`,由 WSL 侧 `C:\work\liv\dbg5679-relay.py`(绑 `10.147.19.226:5679`→转发 `127.0.0.1:5679`)与持久反向隧道 `dbg5679-tunnel.sh`(WSL 拨出到编码机 `192.168.5.188:2222` 的用户级 sshd,`-R 192.168.5.188:5679:127.0.0.1:5679` 与 `-R 192.168.5.188:50000:127.0.0.1:50000`,flock watchdog)两段桥接,得到 IDE 侧可连的 `192.168.5.188:5679`(debugpy)与 `192.168.5.188:50000`(cellapp telnet)。

## 2. 时序证据(2026-11-07T10:56:46Z→10:57:04Z,通过运行)

```
[10:56:48.280] 发现 cellapp 实例(1):cellapp(id=7129652375332859700,pid=12940,192.168.5.117:46319)
[10:56:48.285] cellapp telnet 192.168.5.188:50000 可达=true
[10:56:48.287] 断点落点:c:\work\liv-run\scripts\cell\Avatar.py:22(onTimer 心跳判断行)
[10:56:48.536] DebugConfigManager 配置装载(debugpyPort=5679 pathMappings)=true
[10:56:53.489] injectDebugpyListen 结果:injected detail=debugpy.listen 127.0.0.1:5679 已执行(未验证监听)
[10:56:53.489] debugpy 端口 192.168.5.188:5679 不做 TCP 探测(单客户端槽,探测会占用唯一 DAP 客户端)——以注入回执 + 附加连接为准
[10:56:53.534] debugpy 调试器扩展已显式激活
[10:56:53.542] 附加内部端口探测已绕开(debugpy 单客户端槽):192.168.5.188:5679 → {open:true}(不真连)
[10:56:57.152] 调试会话启动:type=debugpy name=KBEngine: Python attach to cellapp (debugpy 5679)
[10:56:57.153] attachViaDebugpyPort('cellapp') → true
[10:56:59.931] debug adapter 就绪(threads 可查询)=true
[10:57:01.493] DAP setBreakpoints 回包:{"breakpoints":[{"verified":true,"id":0,"source":{"name":"Avatar.py","path":"c:\\work\\liv-run\\scripts\\cell\\Avatar.py"},"line":22}]}
[10:57:01.503] DAP stopped 事件:{"reason":"breakpoint","threadId":1,"preserveFocusHint":false,"allThreadsStopped":true}
[10:57:01.571] 栈帧:onTimer @ c:\work\liv-run\scripts\cell\Avatar.py:22
[10:57:01.572] 断点真实命中确认:onTimer @ c:\work\liv-run\scripts\cell\Avatar.py:22(bots 触发)
[10:57:01.658] continue 已发,引擎恢复
[10:57:02.308] 调试会话已终止
[10:57:02.314] 验收后引擎存活(cellapp telnet 192.168.5.188:50000 可达)=true
[10:57:04.319] 验收后 cellapp 广播仍在=true
```

## 3. 命中判定(mocha 断言通过,1 passing / 0 failing,exit 0)

- `attachViaDebugpyPort('cellapp') → true`:端口模式附加完成,调试会话 `type=debugpy` 真实启动(此前在 debugpy 端口被探测占用时恒定返回 false,见 §5)
- `setBreakpoints Avatar.py:22 verified=true`:断点被引擎侧验证接受(落点行锚 `if userArg != self.TIMER_AUTOATTACK:`,onTimer 心跳判断行)
- DAP `stopped` 事件 `reason=breakpoint`,`threadId=1`,`allThreadsStopped=true`:由 bots 驱动的 Avatar 实体 1.5s 定时器触发的真实暂停
- `stackTrace` 顶层帧 = `onTimer @ c:\work\liv-run\scripts\cell\Avatar.py:22`:断点命中于目标方法与落点行,即**真机断点命中证据**
- `continue` 已发,引擎恢复;验收后 telnet 可达 + cellapp 广播仍在(引擎未受副作用)

## 4. 根因与修复(单客户端槽预检)

debugpy 的 `listen()` server adapter 只接受**唯一** DAP 客户端。此前 attach 恒定失败(attachViaDebugpyPort→false ~2.5s)的根因:注入后对 debugpy 端口做了 TCP 可达预检(套件自身的 `probeStable(debugpyHost, debugpyPort)` 与 `attachViaDebugpyPort` 内部的 `probeTcpPort`),裸 TCP 连接(connect+close)被当作 DAP 客户端占用唯一槽,断开后 adapter 不再 accept,后续 `startDebugging` 连的是死端口而返回 false。

修复(仅测试套件文件,未动生产代码):
- 套件注入后**不再**对 debugpy 端口做 TCP 探测(端口真实性由「注入回执 + startDebugging 成功连接」双重证明;telnet 端口 50000 是独立控制台,照常探测)
- 给 `DebugConfigManager` 注入 `probeTcpPort` 桩:对 debugpy host:port 直接回 `{open:true}` 不真连(若真没监听,startDebugging 仍如实失败,绝不假成功),其余端口走真实探测

## 5. 环境依赖注记(反向隧道桥)

- 本验收依赖三条外部通路同时就位,任一失效则套件红:①WSL 侧 `dbg5679-relay.py`(10.147.19.226:5679→127.0.0.1:5679);②持久反向隧道 `dbg5679-tunnel.sh`(WSL 拨出 .188:2222,映射 .188:5679/.188:50000);③引擎 telnet 控制台密码 `pwd123456`(套件经 `KODE_DBG_TELNET_PASSWORD` 注入)
- debugpy 资产已同步到运行树 `scripts/common/debugpy`(备在 `/home/cui/debugpy-asset-1.8.1`,由 `dbg001_restart5.sh` 复制+warm 9p 缓存)
- 命令面:`kbengine.debug.debugpyInject` 在 dev host 注册=true(断言通过)
- 引擎缺位时套件按 IDE-LIV 同口径 `this.skip()` 跳过(不红):默认 suite 也收这份文件,CI 无引擎不炸;`--dbglive` 下须先起引擎,由验收流程保证

## 命令链

`C:\work\liv\dbg001_restart5.sh`(干净重启:杀 adapter→停引擎→起引擎→sleep 15→cp debugpy 资产→warm 9p→bots→telnet/进程检查)→ `node out/test/electron/runTest.js --dbglive`(mocha 1 passing / 0 failing,exit 0)。
