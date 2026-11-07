# 激活期「视图无数据提供者 + 一直扫描」排查与修复(2026-11-07)

用户现场:KBEngine Explorer 全部视图空,宿主提示「There is no data provider
registered that can provide view data」,同时抱怨「一直在扫描一直在加载」。

## 根因

1. **视图注册晚于全部装配重活**:`activate` 是同步函数,十个侧栏视图的
   `registerTreeDataProvider`/`createTreeView` 分散在装配体尾段
   (修前 entityExplorer ~2818 行、quickActions ~5524 行)。视图 id 在
   package.json 已声明(contributes.views),激活同步体在任何一段抛错或被
   拖死时,视图停在「已声明、无提供者」状态——宿主即报上述错误且视图全空。
   该提示是宿主内置文案,不是扩展日志,与用户截图吻合。
2. **重复扫描**:watchPythonIndex 在 workspace folders 变化与
   assetsRoot/enableMroJump 配置变化两处无条件整组拆除重建,重复/空变化
   通知(同配置重复 fire)每次都伴随 invalidate + 全量后台重扫;排除目录
   (node_modules 等)的文件事件也在 watcher 出口进入合并器后才被消费面
   内部过滤,上游空转。
3. **扫描范围**:盘点确认发现/扫描面已统一走 PY_SCAN_EXCLUDED_DIRS
   (node_modules/third_party/.git/vcpkg/build/dist/out/.tmp/perf/.venv/
   venv/site-packages/__pycache__),工作区发现、外部根 walk、globalDataIndex、
   workspaceIndex、pythonClassIndex、entityMapping 同口径,无遗漏路径;
   本批只补 watcher 出口过滤(src/indexWatcherScope.ts)。
4. **TS/Rust 双轨现状**:workspace 文件发现/扫描仍走 TS(kodeCoreGate 默认
   backend=ts,Rust 仅影子比对不服务,PR-012 设计如此);发现阶段已有
   异步预热+缓存(preheatDiscoveryScan/scanCache),未接 Rust 属既定切流
   路线,不在本批范围。

## 改了什么

| 修复 | 落点 |
| --- | --- |
| 视图占位先行 | `src/startupViewPlaceholders.ts`:activate 首行(任何重活之前)为全部 10 个侧栏视图 id 注册空占位 provider;真 provider 在各自装配位随后注册,宿主同 id 重复注册=后到者接管(extHostTreeViews/mainThreadTreeViews 均覆写),视图从「空列表」自动切到真数据源 |
| 首扫进度提示 | `src/extension.ts` startKbEngineIndexing 接线包 withProgress(entityExplorer 视图位),完成即收 |
| 同签名重建跳过 | `src/indexWatcherScope.ts` watcherPatternSignature:patterns 未变时 watchPythonIndex 直接返回,不再拆除重建+invalidate+全量重扫 |
| 排除目录出口过滤 | `src/indexWatcherScope.ts` isExcludedScanPath:node_modules/.git/out/dist 等路径事件在 watcher 出口丢弃,不进合并器/消费索引 |
| 激活分阶段计时 | `src/activationProfile.ts`:KODE_ACTIVATE_PROFILE_OUT 设置时记录各装配段耗时(常态零开销直通)。注:上表耗时以该模块**临时布线**采样;期二终态 `activate` 未常驻接线(764843d0 的 extension.ts 不含此 import),模块保留作复测工具,非激活常驻面 |

## 前后耗时(xvfb 真 VS Code,tests/fixtures/electron-ws 工作区,
`--panelopen` 套件,KODE_ACTIVATE_PROFILE_OUT 采样)

修前(占位缺失,视图随装配尾段注册):

| 阶段 | step | total |
| --- | --- | --- |
| activate-enter | 0.00ms | 0.00ms |
| config+core-gate | 8.73ms | 8.73ms |
| entity-mapping-manager | 3.15ms | 11.88ms |
| language-providers | 2.07ms | 13.95ms |
| index-watchers | 4.80ms | 18.75ms |
| view:entityExplorer(首个视图) | 18.19ms | **36.94ms** |
| view:serverControl+telnet+playerData+remoteServers | 13.07ms | 50.00ms |
| view:debugTargets | 1.27ms | 51.27ms |
| view:gitHistory+gitRangeHistory | 20.45ms | 71.72ms |
| view:config | 2.49ms | 74.21ms |
| view:quickActions(末个视图) | 5.01ms | **79.22ms** |
| activate-end | 26.32ms | 105.54ms |

修后(占位先行):

| 阶段 | step | total |
| --- | --- | --- |
| activate-enter | 0.00ms | 0.00ms |
| **views-placeholder-registered(全部 10 视图已注册)** | 1.86ms | **1.86ms** |
| config+core-gate | 4.07ms | 5.94ms |
| entity-mapping-manager | 1.21ms | 8.27ms(错峰波动) |
| …真 provider 接管点 | — | 23.09–39.50ms |
| activate-end | 15.26ms | 54.76ms |

结论:**视图「无提供者」窗口从「装配尾段 37–79ms(或永久,若激活中途抛错)
收敛到 ≈2ms,且与后续任何装配失败解耦**。同步激活总时长量级不变(百毫秒
内,波动 55–121ms),首扫本体仍在后台异步,新增进度条消除「一直加载」观感。

## 门禁

- vitest 全量:7230 例,0 失败(PATH=/usr/bin:$PATH)
- tsc -p ./ 0 错误;eslint(src+新增测试文件)0
- 新增/调整测试:tests/startupViewPlaceholders.test.ts 6 例(占位覆盖声明面/
  占位 getChildren 空/激活中途抛错视图仍注册/恰两笔注册/同签名不重建/
  排除目录事件丢弃);extension.test.ts 注册面锁改「占位先行+真接管」两面;
  extensionWarmup.test.ts 按 title 选预热进度记录(首扫进度条并存后口径不变)
- perfCallChainDoc 锚点 9 处随本批行位移真位重探,docs/perf/2026-baseline.md
  §7 出处锁步(并发会话在途提交落位时须再锁步,锚点表内已注记)
