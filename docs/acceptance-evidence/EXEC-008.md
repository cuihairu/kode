# EXEC-008 真机验收证据:真实 VS Code 固定版本扩展完整调试链

- 日期:2026-11-22
- 目标:todo.md EXEC-008(旧 DBG-COMPAT-08)「验收固定扩展完整调试链」中可在编码机上验证的部分——真实 VS Code 装固定版本调试器扩展,对 debugpy.listen 目标完成 connect→断点→单步→变量→断连全链留证
- 套件:`src/test/electron/suite/exec008Live.test.ts`(真机套件,`node out/test/electron/runTest.js --exec008`),双连跑全绿(exit 0×2)
- 完整原始证据(逐行时间戳,含两连跑):同目录 `evidence/EXEC-008-fixed-extension-chain.log`

## 1. 固定版本清单(版本与哈希)

| 组件 | 版本 | 哈希(sha256) | 来源 |
| --- | --- | --- | --- |
| VS Code | 1.144.1 | (系统包,`/usr/share/code/code` linux-x64) | 本机系统安装 |
| ms-python.debugpy | 2024.0.0 | `86d55c7c0c39641e41af7dbbb7cd6e66b51028e058a75dea33cb7d27e96e536f`(VSIX) | Marketplace `_apis/public/gallery/.../vspackage`(gzip 解封装后 zip) |
| ms-python.python | 2024.0.1 | `3eaaa4d22c602d5b1783e6239eb434a844f63917f6a23e07cfd3e93040056946`(VSIX) | 同上 |
| debugpy(目标侧) | 1.7.0(cp37 wheel) | `a5036e918c6ba8fc4c4f1fd0207d81db634431a02f0dc2ba51b12fd793c8c9de`(= PyPI 官方哈希,MATCH) | PyPI |
| debugpy(扩展 bundled) | 1.7.0 | 扩展 `debugpy_info.json` 钉 1.7.0 各平台轮哈希 | VSIX 内置 |

- 扩展自动更新已显式禁用(user-data `User/settings.json` 写 `extensions.autoUpdate:false` + `extensions.autoCheckUpdates:false`,runTest.ts `--exec008` 段预写):第一跑实测未禁时 VS Code 当场触发 "Auto updating outdated extensions. ms-python.debugpy, ms-python.python",固定版本会被会话中途换掉——禁用后两连跑确认扩展目录仍是 2024.0.0/2024.0.1。
- **目标解释器如实口径**:本机系统 Python **3.7.17**(非 3.7.3 字面构建);口径基线文档(`docs/zh/guide/python-debugger-compatibility.md` §7)记录的 3.7.3 临时构建问题与「引擎内上下文」不在本机闭环(见 §5)。

## 2. 链路证据(2026-11-21T22:58:51Z→22:58:58Z 与 22:59:50Z→23:00:01Z 两连跑,均全链断言通过)

```
[22:58:52.032] BREAKPOINT-ADD: workspace=1
[22:58:56.234] CONNECT: startDebugging ok session=6f2000b1-… type=debugpy name=KBEngine Py37 attach
[22:58:56.234] BREAKPOINT-HIT: reason=breakpoint threadId=1
[22:58:56.355] STACK: top=onEnterWorld line=9 frameId=2
[22:58:56.941] SCOPES: Locals,Globals
[22:58:57.036] EVAL-a: 21
[22:58:57.092] EVAL-b-before-step: <error NameError: name 'b' is not defined> (b undefined at line 9 is correct)
[22:58:57.196] VARIABLES[Locals]: a=21, delta=1, self=<__main__.KBEntity object …>
[22:58:57.231] STEP: next issued
[22:58:57.231] STEP-STOP: reason=step
[22:58:57.524] EVAL-b-after-step: 2 (line 10)
[22:58:57.561] DISCONNECT: issued
[22:58:58.763] CHAIN-DONE: breakpoint/connect/stop/step/variables/disconnect all asserted
```

- listen:目标进程 `python3.7 entity_debug.py` 经 `PYTHONPATH=<wheel 解包目录>` 执行 `debugpy.listen(("127.0.0.1", 5678))` + `debugpy.wait_for_client()`(标准附加模式,目标停在干净点等客户端接管)
- connect:`vscode.debug.startDebugging` 真实拉起 `type=debugpy` 会话(等价 F5),adapter = 固定扩展 bundled debugpy 1.7.0
- 断点:行 9(`b = delta * 2`)经 VS Code 在 DAP `initialized` 窗口下发,setBreakpoints 回包 `verified=true`;`stopped reason=breakpoint` 真实命中,顶帧 `onEnterWorld @ line 9`
- 变量:scopes=Locals/Globals;`evaluate a` → `21`;行 9 处 `b` 未定义(NameError,前态正确);Locals 变量面板 a=21, delta=1, self=KBEntity
- 单步:`next` → `stopped reason=step` 落行 10;`evaluate b` → `2`(delta=1,b=delta*2)
- 断连:`disconnect` 后会话正常终止,CHAIN-DONE 全链断言通过(mocha exit 0)

## 3. 协议要点(排障实测,套件注释同步)

- debugpy 的 `attach` 响应延后到 `configurationDone` 之后,目标在 `configurationDone` 后自行恢复运行到断点——断点必须在 `initialized` 窗口由 VS Code 下发。用 `vscode.debug.addBreakpoints` 在 `startDebugging` **之前**预置工作区断点;等 `startDebugging` 返回后再 `setBreakpoints`+`continue` 对已运行目标无效(裸 DAP 探针与 adapter 日志双侧实证:1.7.0 不回 stopped,实机挂死 300s)
- DAP 标准 `stopped` 事件不进 `onDidReceiveDebugSessionCustomEvent`(该 API 只转发自定义事件),必须走 `registerDebugAdapterTrackerFactory('debugpy')` 的 `onDidSendMessage`(dbglive 同坑同法)
- `python: '/usr/bin/python3.7'` 钉死 adapter 解释器:不钉时 ms-python 走自动发现,空工作区可能弹「选择解释器」quickpick 在 headless/xvfb 永不关闭 → startDebugging 挂死
- 扩展自动更新必须禁(§1),否则固定版本会在会话中途被换掉、固定链不可复现
- `@vscode/test-electron` 的 `vscodeExecutablePath` 必须指向**真 electron 二进制**(`/usr/share/code/code`),指向 `/usr/bin/code`(CLI 启动壳,`ELECTRON_RUN_AS_NODE=1 … cli.js` fork 后立即 exit 0)会让 harness 误判「测试已完成」而零输出零用例

## 4. 环境依赖与命令链

- `xvfb-run -a`(无 WM 亦可,API 驱动不依赖 UI 坐标;--disable-gpu/--no-sandbox 由 runTest 基座注入)
- 目标启动:`PYTHONPATH=.vscode-test/exec008/site python3.7 .vscode-test/exec008/target/entity_debug.py`(wheel 解包目录,`.vscode-test/` gitignored 持久,工件含 downloads/site/ext/target/evidence)
- 运行:`KODE_EXEC008_WORKSPACE=<target 工作区> KODE_EXEC008_EXTENSIONS_DIR=<固定扩展目录> KODE_EXEC008_OUT=<证据文件> xvfb-run -a node out/test/electron/runTest.js --exec008`

## 5. 诚实边界(不勾行依据)

本验收闭掉的是「真实 VS Code + 固定版本扩展 + Python 3.7.x 解释器」的完整调试链。todo.md EXEC-008 剩余两臂不在本机可闭,须用户真机:
1. **Python 3.7.3 引擎内上下文**:口径基线记录的手搓 CPython 3.7.3 listen exit 139 未破案;本机系统 3.7.17 可用但不等价于「引擎内 3.7.3」——真机引擎(KBEngine 内嵌 Python)中的 listen/附加须在引擎机复验
2. **升级后独立复验**:固定扩展/包升级后的独立复验轮须在真机升级场景执行(本机固定链仅证明当前固定组合可用)
