# RUST-011 审计:索引存储为派生缓存而非数据真相,损坏可以重建,不可静默修改用户文件

日期:2026-11-15。审计对象:todo.md RUST-011。方法:三判据全谱核对(内存索引/磁盘派生面/用户域写点逐个归类)。**结论:三判据全部 PASS,零生产码改动;用户域触点(pyrightconfig.json/python settings extraPaths)以「managed-entries 台账」为登记机制,护栏与测试钉在案。**

## 1. 判据①索引=派生缓存非真相:PASS

- 全部语义索引在内存、可从文件事件重建:entityMapping/globalDataIndex/workspaceIndex/spaceDataIndex 内存 Map+LRU,真相只有盘上 def/XML/py 文件(RUST-008 §2 已核);增量失效三面已审(RUST-006:per-file reconcile+依赖闭包定向失效+无关缓存保留,重建口径成立)。
- 磁盘派生面全部在 Managed 域 `.kbengine/**` 且可重建:stubs(copy-if-absent 从内置模板,零覆盖铁律)、inferred/ 镜像(内容比对零写)、debug.json(缺失即重生成骨架,批143)、cpuProfile 落 tmpdir。无任何持久索引文件落盘——索引断电即失,重启重建,真相永在用户文件里。

## 2. 判据②损坏可以重建:PASS

- 重建命令在位:`kbengine.python.resetStubs`(确认后模板集重复制,tests/pythonStubExport.test.ts「确认重置」钉)、`kbengine.debug.resetAttachMode`;copy-if-absent 语义缺的自动补上;索引面文件事件即重建(AUD-071 根新增全量失效为登记理由)。
- 台账(workspaceState managed-entries)是元数据不是缓存,丢失的下一次同步按「previous=undefined」重新按护栏收敛,不依赖旧账正确。

## 3. 判据③不可静默修改用户文件:PASS(managed-entries 登记机制)

用户域写点逐个归类(全仓 18 个写文件模块过目):

| 面 | 目标 | 触发 | 护栏 |
|---|---|---|---|
| stub 导出/extraPaths 同步/pyrightconfig 接线 | `.kbengine/stubs`(Managed)、python settings extraPaths、工作区根 pyrightconfig.json | 设置门 `kbengine.python.stubExport`/`extraPathsSync`(文档化,默认开)+桩包真在盘才进 processMode(pythonExtraPaths.ts:290-292,388-392) | **只更新自己上次写的条目**(workspaceState 台账,用户编辑的条目归用户);JSONC 注释与用户键保留;TOML tool.pyright/extends/不可解析一律告警+原文件保留;用户 stubPath 尊重不夺;非静默模式播报写入面 |
| 推断管道落盘 | `.kbengine/**`(Managed)或显式 `kbengine.infer.sourceWrite=user` | assertWritable 铁律 | scripts/** 默认不可写,绝不静默 |
| 临时编辑热更 | 用户 scripts | 显式命令+失败 showErrorMessage | 非静默 |
| quickActions/debugConfig 生成/databaseWiring 保存/SDK 生成 | 用户指定目标 | 全部用户命令触发 | 非静默 |
| managedDirExclusions | search.exclude/files.watcherExclude 自己的段 | 只管理自己那一段 | **.gitignore 绝不创建**(inferPipeline.ts 头注铁律) |

- 守护栏测试钉在案:pythonProcessStubs.test.ts「preserves JSONC and user settings, is idempotent, and retains edited environments」「preserves user stub paths and refuses a global KBEngine package」;pythonStubExport.test.ts copy-if-absent/用户魔改保留/确认重置族;managedDir/managedDirExclusions 域判定。
- 原子写基础设施在位(backend/atomicFileWrite.ts,codeGenerator/projectCreate/generatorForms 消费),写半截不留脏文件。

## 4. 判定依据与边界

- 「派生缓存」语义=可由真相文件全量重建的表示;本仓所有索引与 `.kbengine/**` 产物满足;用户域两触点(pyrightconfig/extraPaths)不是缓存而是**登记的接线写入**,靠 managed-entries 台账+设置门+保留护栏满足「不静默」——如实登记,不声称零写用户域。
- 性能资产(tmpdir)与日志导出(save dialog 用户选位置)均在用户同意路径上。

## 5. 门禁

纯审计零生产码;引用测试面全部现役(pythonProcessStubs/pythonStubExport/pythonExtraPaths/managedDir* 家族),无新增断言需求。
