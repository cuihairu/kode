# COREDISCOVER-001 win32 真机取证(2026-11-28)

todo.md 3198 的最后残留臂:真机删 `bin/kode-server.exe` → 激活 → 放回 → 灯自动转 ok。
实现载体 02336546;⑥对抗审查 PASS 2026-11-28(watcher 三事件+300ms 防抖
→ rerediscoverCore → gate.setConfig(现场 discoverKodeServerBinary 非缓存)+刷新注册表
双面;showPanel 先 rerediscover 再 render;vitest 27/27+bundleLoadSmoke 双语 2/2)。

## 环境

- imac win32,隔离 profile:`--extensions-dir`/`--user-data-dir` 均在
  `C:\Users\cui\kode-corediscover-001\verification\`;`kode-0.2.0-win32-fix2-20261127.vsix`
  (与 KODE-WINPKG-001 同包);workspace=最小 KBEngine assets;trust/autoUpdate off。
- 驱动 `schtasks /IT` 进交互会话启动 Code.exe;探针经 `--extensionTestsPath` 在 exthost
  内跑;进程取证一律 `Get-CimInstance Win32_Process` 取 ExecutablePath 并按路径打
  `ours` 标(操作者主 VS Code 自带一份 kode-server.exe,pid 10672,不触碰只过滤)。
- Phase D 前置:装完即 `Move-Item bin\kode-server.exe` 出 bin(backup 在 probe root),
  `bin-after-delete.list` 留档。

## Phase D:删除后激活 = degraded 面,零 spawn

- `gate-config`:backend=rust,serverPath 未配。
- `bin-integrity`:manifest 其余文件 sha256 全 match;`kode-server.exe =
  "ABSENT (phase D by design)"`。
- `procs-degraded`:全机仅操作者自有实例(pid 10672,path `.vscode\extensions\...`,
  ours:false)→ 隔离安装零 spawn,degraded 面成立。

## Phase R:原子放回 → watcher 自动重发现 → spawn+ready(无 reload、无面板参与)

- `restore-issued` 00:55:26.217Z:copy 到 `bin\.kode-server.exe.restore` 再 rename——
  原子落位,watcher 不可能见到半写 PE。
- 约 0.5s 后(300ms 防抖+spawn 耗时)Index 通道:
  ```
  [ +24.7s][kode-index][server] spawned (pid 33512)
  [ +24.7s][kode-index][server] ready (generation 0, server 0.2.0)
  ```
  (窗口日志起点 20261128T085502 local,+24.7s ≈ restore 后 0.5s)
- CIM 核验:pid 33512 ExecutablePath =
  `c:\Users\cui\kode-corediscover-001\verification\extensions\cuihairu.kode-kbengine-0.2.0\bin\kode-server.exe`
  (ours:true)→ spawn 来源=隔离安装 bin,非操作者实例。
- 存活:`procs-restored`(+15s)与 `procs-final`(+40s)两次快照均含 33512;探针全程
  不调 reload,首开健康面板被刻意排在 `procs-final` 之后 → 证据时刻 watcher 臂独立
  于面板臂成立。
- runs 3+4 双跑复现(run3 同构:放回后 spawn+ready,CIM 路径核验 ours:true)。

判读:删→放回自动恢复链 = bin watcher(onDidCreate/DidChange/DidDelete+300ms 防抖)
→ rerediscoverCore → gate.setConfig → serve client spawn。验收口径「灯自动转 ok」
的 ok 态前提(serve client spawned+ready)由此生命周期直接证成;degraded 态由
Phase D 零 spawn+ABSENT 完整性证成。

## 截图(如实边界)

`evidence/COREDISCOVER-001-{degraded,restored-statusbar,restored-healthpanel}.png`
为整屏 CopyFromScreen 帧:落在操作者活跃桌面(操作者正用终端盯本会话+IME 候选条+
自有窗口),焦点自动化(SW_MAXIMIZE+TOPMOST+SetForegroundWindow)后 z-order 仍被
操作者活动夺回,4 跑一致,状态栏灯面在帧内不可辨。依「真机边界如实记」判例:不以
视觉帧充数,两态以 Phase D/R 程序证据承重,截图仅作现场存档。

## 残留观察(不阻塞验收,记录在案)

- 打开 `kbengine.core.healthPanel` 之后 serve client 似被停止(runs 2+3 一致:
  `procs-restored` 存活、驱动收尾收集时已消失;Index 通道无 exit/respawn 行)。
  与 watcher 臂无关(showPanel 内 rerediscover+render 的行为面),留待后续批定点。
