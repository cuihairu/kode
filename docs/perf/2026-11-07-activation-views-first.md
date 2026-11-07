# 激活期「视图无数据提供者 + 一直扫描」排查与修复(2026-11-07)

用户现场:KBEngine Explorer 全部视图空,宿主提示「There is no data provider
registered that can provide view data」,同时抱怨「一直在扫描一直在加载」。

本批基线:隔离 worktree,HEAD = `01bbd7be`(C-22 之后、并发会话 C-23 在途
之前);全部测试与耗时采集在该 worktree 完成。

## 根因

1. **视图注册晚于全部装配重活**:`activate` 是同步函数,十个侧栏视图的
   `registerTreeDataProvider`/`createTreeView` 分散在装配体尾段(修前
   entityExplorer ~37ms、quickActions ~79ms 才注册,耗时见下表)。视图 id 在
   package.json 已声明(contributes.views),激活同步体在任何一段抛错或被
   拖死时,视图停在「已声明、无提供者」状态——宿主即报上述错误且视图全空。
   该提示是宿主内置文案,不是扩展日志,与用户截图吻合。
2. **重复扫描**:watchPythonIndex 在 workspace folders 变化、assetsRoot/
   enableMroJump 配置变化、活动 profile 切换三处无条件整组拆除重建,且失效
   (invalidate)在重建之前无条件执行——重复/无实质变化的通知(同配置重复
   fire)每次都伴随整库失效 + 全量后台重扫;排除目录(node_modules 等)的
   文件事件也在 watcher 出口进入合并器后才被消费面内部过滤,上游空转。
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
| 视图占位先行 | `src/startupViewPlaceholders.ts`:activate 首行(任何重活之前)为全部 10 个侧栏视图 id 注册空占位 provider;真 provider 在各自装配位随后注册,宿主同 id 重复注册=后到者接管(mainThreadTreeViews `$registerTreeViewDataProvider` 内 `this._dataProviders.set(...)` 覆写 + `viewer.dataProvider = dataProvider` 重挂),视图从「空列表」自动切到真数据源。占位 provider 带识别标记(STARTUP_VIEW_PLACEHOLDER_MARKER)供测试断言首笔/末笔归属 |
| 首扫进度提示 | `src/extension.ts` startKbEngineIndexing 接线包 withProgress(entityExplorer 视图位,cancellable=false),完成即收 |
| 同签名重建跳过 + 失效闸门 | `src/indexWatcherScope.ts` watcherPatternSignature:patterns 未变时 watchPythonIndex 返回 false,三个调用点的整库失效(pythonClassIndex/dataDictIndex.invalidate)、外部 watcher 重建(refreshExternalRootWatchers/refreshExternalWatchers)一并跳过;真实根切换(签名变化)保持原失效/重建序列不变(测试锁定两面) |
| 排除目录出口过滤 | `src/indexWatcherScope.ts` isExcludedScanPath:node_modules/.git/out/dist 等路径事件在 watcher 出口丢弃,不进合并器/消费索引 |
| 激活分阶段计时 | `src/activationProfile.ts`:KODE_ACTIVATE_PROFILE_OUT 设置时记录各装配段耗时;未设置时每次 mark 只有一次字符串比较护栏(非零成本,但无 I/O、无记录) |

### 评审轮修复(三轮 delta 复审 FAIL→返工,四轮复审过)

- **父根→子根切换摘活数据**:差集只比根字符串,根切到自身子目录(`/a`→`/a/scripts`)
  时 `removeRoot(父)` 把仍在根集内的子根记录连带摘掉且无扫描接替。修:`EntityMappingManager.removeRoot`
  /`SemanticIndex.removeRoot` 增 `keepSubtrees` 口径,摘除收窄到保留子树之外(变异验证:keepSubtrees
  恒空时回归测试红)。
- **watcher 组装载失败锁存过早**:签名/基线原在创建前提交,中途抛错留下「签名已换、watcher 缺根」
  且被同签名守卫挡死。修:staged 构建、整组成功后才提交签名/基线,失败清签名保旧组、下个事件重试
  (变异验证:提前锁存时摘根基线污染、回设旧根误摘新根,回归测试红)。
- **路径大小写折叠按平台**:`normalizePathForCompare` 原无条件小写,POSIX 上仅大小写不同的段被误判;
  修为仅 win32 折叠(测试显式实参覆盖)。

## 前后耗时(xvfb 真 VS Code 扩展宿主,tests/fixtures/electron-ws 工作区,
`--panelopen` 套件,KODE_ACTIVATE_PROFILE_OUT 采样;各表为单次完整运行,
宿主计时精度受机器负载波动影响,量级可信)

修前(占位缺失,视图随装配尾段注册;单次运行):

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

修后(占位先行;单次运行,与上表非同机同刻,只比结构不比绝对值):

| 阶段 | step | total |
| --- | --- | --- |
| activate-enter | 0.00ms | 0.00ms |
| **views-placeholder-registered(全部 10 视图已有数据提供者)** | 1.86ms | **1.86ms** |
| config+core-gate | 4.07ms | 5.94ms |
| entity-mapping-manager | 0.94ms | 6.88ms |
| language-providers | 1.24ms | 8.12ms |
| index-watchers | 2.51ms | 10.63ms |
| view:entityExplorer(真接管) | 9.32ms | 19.95ms |
| …其余真接管点 | — | 26.46–38.22ms |
| activate-end | 17.09ms | 55.31ms |

结论(按证据口径):

- **数据提供者注册窗口**:从「装配尾段 37–79ms(且激活中途任何一步抛错即
  永久缺失,宿主报错、视图全空)」收敛到「≈2ms 全部就位,与后续装配成败
  解耦」。该结论来自扩展宿主内 registerTreeDataProvider 调用时点采样;
  视图 UI 渲染完成时点未单独测量,不在此声明。
- 同步激活总时长量级不变(百毫秒内),首扫本体仍在后台异步,新增进度条
  消除「一直加载」观感。
- 重复 assetsRoot 通知:整库失效从「每次通知必失效」降为「签名变化才失效」
  (tests/startupViewPlaceholders.test.ts 重复通知 0 失效/真实切换恰 1 次失效
  两例锁定)。

## 门禁

- vitest 全量:7230+ 例,0 失败(PATH=/usr/bin:$PATH,隔离 worktree)
- tsc -p ./ 0 错误;eslint(src+新增测试文件)0;docs:build 通过;
  vsce package 通过(本批不触 CI 其余 docker/多平台腿,如实声明未本地复跑)
- 新增/调整测试:tests/startupViewPlaceholders.test.ts 8 例(占位覆盖声明面/
  占位 getChildren 空/激活中途抛错视图仍注册/每视图恰两笔且首笔占位末笔真
  接管/同签名不重建+重复通知零失效/真实切换恰一次失效/排除目录事件丢弃);
  评审轮追加 5 例(父根→子根保留子树/watcher 装载失败重试+基线不污染/
  isPathWithin 面/POSIX 大小写敏感);extension.test.ts 注册面锁改「占位先行+
  真接管」两面;covExtensionCommands 取末笔注册;extensionWarmup 按 title 选
  预热进度;perfCallChainDoc 锚点 9 处真位重探(rebase 合并树后
  652/665/950/1032/1083/1160/1558/2540/2620),
  docs/perf/2026-baseline.md §7 出处锁步
