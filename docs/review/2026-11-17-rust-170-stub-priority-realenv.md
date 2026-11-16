# RUST-170 真机验证:Pylance / Pyright 的导航与 stub 优先级

- 日期:2026-11-17
- 结论:**两真实服务器实测同裁定——绝对 import 的解析序 = stubPath → extraPaths → 同目录 .pyi**。旧文档口径「同名 .pyi → stubPath → extraPaths」是事实性错误(importer 自身目录不是绝对 import 的搜索根,同目录 .pyi 只在无其他来源时兜底命中),已按实测顺修 `src/pythonExtraPaths.ts` 两处注释与 `docs/guide/configuration.md`(en+zh)对应句。
- 车道:pyright = 独立 LSP 客户端驱动真进程(`scripts/verify/lsp-stub-priority.mjs`);Pylance = 真 VS Code + 真扩展宿主(`src/test/electron/suite/pylanceStubPriority.test.ts`,经 `node out/test/electron/runTest.js --pylance` + `KODE_PYLANCE_WORKSPACE`)。

## 版本与夹具

- pyright-langserver 1.1.414(本机 `pyright-langserver --stdio`,serverInfo 实证);
- Pylance ms-python.vscode-pylance-2026.4.1(`.vscode-test/extensions`,经 `--extensions-dir` 挂入测试宿主);
- 夹具:`--emit-fixture` 预建三层同名 `KBEngine.pyi`(签名/文档串互异可辨层)——`scripts/KBEngine.pyi`(同目录 decoy,`addTimer(interval: float) -> int` / "tier1 same-dir decoy")、`.kbengine/stubs/KBEngine.pyi`(stubPath 层,`repeat: int = 0` / "tier2 stubPath")、`extraroot/KBEngine.pyi`(extraPaths 层,返回 `str` / "tier3 extraPaths");调用点 `scripts/entity/Avatar.py` 的 `KBEngine.addTimer(1.0)`;配置:pyright 车道写 `pyrightconfig.json`(stubPath/extraPaths),Pylance 车道写 `.vscode/settings.json` 的 `python.analysis.stubPath` / `python.analysis.extraPaths`(**Pylance 不读 pyrightconfig.json**——实测前提,两车道各写各的配置面),并把 kode 自身 stub 同步关掉防激活链写设置污染测量面。

## pyright 车道(独立 LSP 客户端,四变体 4/4 PASS)

| 变体 | 层况 | 期望(=实测裁定) | 实测落位 |
|---|---|---|---|
| A | 三层并存 | stubPath | `.kbengine/stubs/KBEngine.pyi` ✅ |
| B | 裁同目录 | stubPath | `.kbengine/stubs/KBEngine.pyi` ✅ |
| C | 同目录+stubPath 缺 | extraPaths | `extraroot/KBEngine.pyi` ✅ |
| D | 有同目录,无 stubPath | extraPaths | `extraroot/KBEngine.pyi` ✅ |

D 变体是关键反证:同目录 .pyi 在场,**extraPaths 仍胜出**——同目录不参与绝对 import 解析。证据 JSON 全文见验证脚本 stdout(`/tmp/pyright_evidence2.json`,含 serverInfo/hover/definition 行号)。

## Pylance 车道(真 VS Code + 真扩展宿主,三段阶梯全绿)

逐级物理裁层 + 轮询 `vscode.executeDefinitionProvider`(presence 口径:期望落点出现在结果集),hover 原文随证据落盘(mocha `[rust-170-pylance]` 输出行):

| 阶段 | 动作 | 期望 | 实测落位 | hover 佐证(Pylance 段) |
|---|---|---|---|---|
| A | 三层并存 | stubPath | `.kbengine/stubs/KBEngine.pyi` ✅ | `def addTimer(interval, repeat: int = 0) -> int` + "tier2 stubPath" |
| B | 删 stubPath 文件 | extraPaths | `extraroot/KBEngine.pyi` ✅ | (tier3,同目录在场不参战) |
| C | 再删 extraPaths 文件 | 同目录 | `scripts/KBEngine.pyi` ✅ | `def addTimer(interval: float) -> int` + "tier1 same-dir decoy" |

C 阶段同时证明同目录仍是一条真实解析来源——只是排位最低,与其他来源并存时永不胜出。全流程 11s 完成三段落位(Pylance 每次裁层后数秒内重解析,无缓存僵死)。

## 旧口径证伪(prove-red 性质)

首轮真机按文档口径断言(A 期望=同目录 .pyi)**红**:Pylance 实际返回 `targets=["…/.kbengine/stubs/KBEngine.pyi"]`(run1 日志,1 failing)——这条红就是文档口径被证伪的实测证据;按实测改期望后 pyright 4/4 + Pylance 3/3 全绿。文档与代码注释按实测顺修四处:

1. `src/pythonExtraPaths.ts` 文件头 CFG-03 注释(解析序);
2. `src/pythonExtraPaths.ts` syncPythonExtraPaths stubPath 写点注释(同);
3. `docs/guide/configuration.md` 解析序句(en,带本文档指引);
4. `docs/zh/guide/configuration.md` 解析序句(zh,同)。

## 对接线面的含义(只读事实,零生产行为改动)

- kode 把导出桩写进 `python.analysis.stubPath`(CFG-03)恰好落在实测序的**第一级**:即使用户 extraPaths 里有旧的混合 KBEngine 桩包,导出桩仍胜出——接线稳健性比旧文档口径描述的更强,无需改行为;
- 「用户自设 stubPath 永不覆盖」(CFG-03)不变:用户若自设 stubPath 指向旧桩,kode 不抢写,冲突照旧由既有契约面报告。

## 边界(不声称的部分)

- 「跳转落位」以 `executeDefinitionProvider` 返回的真实 URI 为准——这正是编辑器 F12 消费的同一 API;VS Code UI 的 reveal 动画本身不再单独声称;
- hover 证据里 kode 自身的多面 hover 与 Pylance 的 markdown 并存(两 provider 都应答,presence 口径只裁 definition 落点,hover 全文如实记录);
- Pylance 捆绑 server 仅在 VS Code 扩展宿主内驱动:脱离宿主的 `server.bundle.js --stdio` 对 initialize 零响应(首轮实测),故 Pylance 车道不存在独立进程版,standalone 泳道已从脚本移除(死车道不保留);
- 夹具是 ASCII 最小工程(三层签名互异),非真实项目;真实项目多根/多环境拓扑不在本条范围;
- pyright 车道证据出自 2026-11-17 本机两轮(首轮 4/4 与复跑 4/4 同裁定);Pylance 车道 run1(证伪红)+ run2(全绿)日志为真机记录。
