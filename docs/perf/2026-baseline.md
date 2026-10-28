# Kode 语言服务性能基线报告(2026)

- 日期:2026-10-23
- 基线代码:PR1「性能观测与基线」提交(commit hash 见 `docs/review/2026-10-22-unified-semantic-index-refactor.md` 跟踪表;本报告与该提交同树)
- 评审来源:docs/review/2026-10-22-unified-semantic-index-refactor.md §2(性能基线与调用链审计)

## 1. 测试环境

| 项 | 值 |
|---|---|
| OS | Linux(host 内核 7.0.0-38-generic) |
| CPU | Intel(R) Core(TM) i9-10880H @ 2.30GHz,14 逻辑核 |
| 内存 | 45GiB(量测时 buff/cache 33GiB,热缓存口径) |
| 存储 | sda,ROTA=1(机械盘特征;具体介质待确认) |
| Node.js | v24.21.0 |
| 量测框架 | vitest 5.0.3(`vitest.bench.config.ts`)+ fake-vscode 桩,真实索引实现 |
| 观测开销 | PR1 埋点已启用(聚合口径,详细记录关闭);数字含埋点开销 |

## 2. 测试资产集

由 `scripts/generate-perf-assets.mjs` 确定性生成(`--large-files 30000`):

| 场景 | 文件数 | 组成 |
|---|---|---|
| small | 7 | 最小资产树(行为口径) |
| large | 30,005 | 30,000 个生成 .py(1 类 2 方法)+ Avatar 骨架 |
| multi-root | 18 | 3 个独立资产根,同名实体 Avatar、同名类 Inventory |
| big-py | 5 | 单文件 8,000 方法(局部变量推导最坏路径) |
| def-heavy | 1,323 | 1,200 个 .def + 40 组 entities/types/alias.xml 变体 |
| noise | 406 | .git/build/third_party 各 200 个干扰 .py(须被排除) |

## 3. 七场景实测数字(真实代码路径,非桩实现)

复现:`KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/baseline.bench.ts`
原始输出:`docs/perf/baseline-run.txt`

> 时点注意:本表数字为 PR1 时点(提交 89e8783,P0 修复前)。P0 修复系列(492fc40..b9c8acb)后同 bench 复测见 `docs/perf/baseline-run-post-p0.txt`(S1 冷扫 107,737ms→4,880ms),对账与取舍分析见 [docs/review/2026-10-27-r1-migration-data-audit.md](https://github.com/cuihairu/kode/blob/main/docs/review/2026-10-27-r1-migration-data-audit.md)。

| # | 场景 | 指标 | 实测 |
|---|---|---|---|
| 1 | 冷启动首次索引(large,30,001 个 .py) | 首次类名查询总耗时 | **107,737 ms(≈107.7s,≈3.6ms/文件)** |
| 1b | 冷启动 entity-mapping 首扫(def-heavy,1,320 .def) | waitForInitialScan | **652 ms** |
| 5′ | .def 修改后热复扫(mtime 缓存命中) | scanEntityMappings | **17 ms**(对比冷扫 652ms,≈38×) |
| 2 | 索引就绪后重复查询 findClassesByName | P50/P95/P99 | 0.01 / 0.02 / 0.04 ms(n=200) |
| 2 | 索引就绪后 computeMRO | P50/P95/P99 | 0.01 / 0.04 / 1.33 ms(n=40) |
| 3 | 新文件落盘后首次查询(未索引文件) | 索引+查询 | **0.75 ms** |
| 4 | 编辑当前文件后查询(big-py,局部变量) | P50/P95/P99 | 0.04 / 0.14 / 79.93 ms(n=20;P99 来自首轮,含 MRO 缓存清空后重建) |
| 6 | 删除 .py 后失效+旧类不再命中 | 失效耗时/命中数 | **6.7 ms / 0 命中** |
| 7 | 60 路并发查询(multi-root 同名类) | wall / 总命中 | **0.34 ms / 360**(6 定义 × 60 查询,跨根不丢) |
| 7 | rootsContaining(组合根,20 次) | P50/P95/P99 | <0.01 / 0.01 / 4.58 ms |
| 8 | 排除式目录不进索引(noise) | 冷扫 / 泄漏类命中 | **1.6 ms / 0 泄漏** |

## 4. 关键发现(基线事实,非优化结论)

1. **冷启动全量 Python 扫描是唯一的秒级瓶颈**:30,001 文件 ≈107.7s(≈3.6ms/文件),验证评审「首次 Definition 被全仓扫描阻塞」的方向。热路径(场景 2/3/4/6/7)均在亚毫秒~低毫秒级。
2. **mtime 缓存有效**:.def 全量扫描 652ms → 热复扫 17ms;单位文件解析不是当前主要矛盾。
3. **编辑后单次 P99 尖峰 79.9ms**(big-py 8,000 方法文件):源于 `updateFile` 清空 MRO 缓存后的重建,量级可接受但应跟踪。
4. **排除式扫描口径正确**:build/third_party/.git 共 600 个干扰 .py 未进索引。

## 5. 待测项(本报告如实标注,不预设结论)

- [ ] VS Code 真实 UI 端到端延迟(hover/definition/completion 真实激活路径,electron 集成):待测 —— 本报告全部为 fake-vscode + 真实索引实现的服务层耗时,不含 UI 序列化与 provider 调度。
- [ ] VS Code 内冷启动场景(扩展激活 → 首次请求),含 EntityMappingManager 与 PythonClassIndex 竞争:待测。
- [ ] 冷/热磁盘缓存分离量测(本报告为热缓存口径):待测。
- [ ] 多资产根场景在 VS Code 内的同名实体导航正确性走查:待测(服务层跨根命中已验证:360/360)。
- [ ] Windows / macOS 平台与慢盘(网络盘)表现:待测。
- [ ] 诊断(.def/entities.xml)批量校验耗时分布:待测(validateDocument 打点已就位,数据待采集)。

## 6. PR1 观测基建清单

- `src/languageServiceMetrics.ts`:单调时钟(perf_hooks)、请求 ID、11 类事件(hover/definition/completion/diagnostics/python-index-scan/python-composition-roots/entity-mapping-scan/semantic-query/type-registry-query/file-discovery/document-parse)、子阶段计时、文件发现/读取/解析计数、缓存命中率、是否等初始化、状态(ok/miss/cancelled/error);详细样本默认关闭(`kbengine.metrics.detailed` 开启)。
- 埋点接入:hover/definition/completion/诊断(extension.ts 适配层)、provideDefinitionTraced(semantic-query)、resolveEntityAnnotationType(type-registry-query)、ensureScanned/ensureCompositionRoots、scanEntityMappings、findFilesAcrossRoots、updateFile(document-parse)。
- 汇总出口:命令面板 `KBEngine: Show Language Service Metrics Summary`(输出 P50/P95/P99/最大值/命中率/计数)。
- 资产生成:`scripts/generate-perf-assets.mjs`;bench:`tests/perf/baseline.bench.ts`(不进 `pnpm test` 门禁)。

## 7. 主要调用链图(真实路径取证,Mermaid)

> 口径说明:§3 的数字是 PR1 时点(提交 89e8783)实测;本节四条链是 **main 当前代码**的真实调用路径(file:line 以落稿时该分支 HEAD b0732e8 为准,含 PR2 快照/PR3 调度器/PR5 去阻塞/PR6 诊断版本守卫,以及 kode2 phase2-slice-a 双轨 shadow 对拍面)。等待点(可能阻塞请求返回的位置)统一用虚线框标出;shadow 对拍腿均为 fire-and-forget,不阻塞返回,不标等待点。

### 7.1 Hover(Python → 实体标注 → 同步回退)

```mermaid
flowchart TD
  VC1["VS Code: registerHoverProvider.provideHover(document, position, token)"]
  M1["extension.ts:575 打点<br/>startLanguageServiceOperation('hover', fileKind, documentVersion)"]
  HP["KBEngineHoverProvider.provideHover<br/>languageProviders.ts:732"]
  CFG["getLanguageFeatureConfig() 开关快照"]
  WORD["getWordRangeAtPosition + getText(range)<br/>读 VS Code 缓冲区,不读磁盘"]
  BR{"languageId==python 且<br/>注入 EntityMappingManager?"}
  KN["provideKnownHover 同步链<br/>(词法/静态规则,无异步面)"]
  POS{"位置形态判定(依序)"}
  D1{"def 声明行方法名?"}
  D2{"self.段.方法?<br/>(receiverSections 开)"}
  D3{"self.属性?<br/>(builtinProperties 开)"}
  RA1["raceWithBudget('hover:def-method', …, 2500ms)<br/>hoverBudget.ts:59"]
  RA2["raceWithBudget('hover:receiver-call', …, 2500ms)"]
  RA3["raceWithBudget('hover:builtin-property', …, 2500ms)"]
  RS1["resolveDefMethodAnnotation → def 索引<br/>(形参个数/注解类型闸)"]
  RS2["resolveReceiverCallAnnotation<br/>段过滤 → 形参/类型对账"]
  RS3["resolveBuiltinPropertyAnnotation → 分面内建属性表"]
  LINES["documentStore.getDocumentLines<br/>同版本行快照复用(PR2)<br/>languageProviders.ts:661 / documentStore.ts:154"]
  MISS["标注落空 → 回退 provideKnownHover"]
  END1["operation.end(ok|miss) → return Hover|null"]

  VC1 --> M1 --> HP --> CFG --> WORD --> BR
  BR -- "否" --> KN
  BR -- "是" --> POS --> D1
  D1 -- "是" --> RA1 --> RS1
  D1 -- "否" --> D2
  D2 -- "是" --> RA2 --> RS2
  D2 -- "否" --> D3
  D3 -- "是" --> RA3 --> RS3
  D3 -- "否" --> KN
  RS1 --> HIT{"标注命中?"}
  RS2 --> HIT
  RS3 --> HIT
  RS1 -.->|行数据| LINES
  HIT -- "否" --> MISS --> END1
  HIT -- "是" --> END1

  WAITA("等待点 A:hoverAsyncBudgetMs=2500 总预算<br/>超时 → resolve null(不永转 loading)+ LogHub warning<br/>(kbengine.hover.asyncBudgetMs,≤0 关闸原样透传)")
  RA1 -.->|预算闸| WAITA

  classDef waitPoint fill:#fff3cd,stroke:#d97706,stroke-dasharray:5 4;
  class WAITA waitPoint;
```

### 7.2 Definition(Python F12,层序即 provideDefinitionTracedImpl 实际顺序)

```mermaid
flowchart TD
  VC2["VS Code: provideDefinition(document, position)"]
  M2["extension.ts:607 打点 startLanguageServiceOperation('definition')<br/>(.def 侧另有 :666 一路)"]
  AD2["PythonDefinitionProvider.provideDefinition<br/>languageProviders.ts:3692"]
  TR["provideDefinitionTraced → Impl<br/>semantic-query 打点 :3664 / Impl :3682"]
  CTX{"isPythonCodePosition<br/>注释/字符串内直接 skip"}
  KBE{"kbe/KBEngine 模块符号?"}
  STUB["内置桩文档(buildKbeStubDocument)"]
  CB{"class X(Base) 基类位?"}
  CB1["kbe from-import 桩"]
  CB2["pythonClassIndex.resolveClassBase :1175<br/>(显式 import 绑定优先)"]
  CB3["findEntityDefinitionFile → .def<br/>getEntityRuntimeProfile → 实体脚本"]
  REV["types.xml implementedBy 反向跳转"]
  L0["层0 接收者段闸(languageProviders.ts:4092)<br/>self.段.方法:段不符即 miss"]
  L1["层1 entity-def 属性子探<br/>resolvePropertyDefinitionForClass / resolvePropertyDefinition"]
  SCAN["indexScheduler 队列(首扫在途时)"]
  TY["findCustomTypeDeclarationInfo 自定义类型声明"]
  MRO["PR5 两段方法解析(pythonClassIndex.ts:1287)<br/>① 静态类 MRO 命中仅记录——不提前返回<br/>(同一 mixin 可被多实体组合,静态命中只是候选之一)<br/>② 组合根 MRO + .def 声明 mixin:每根先精确类身份<br/>再 def mixin;多根命中全保留,provider 出 Location 列表"]
  PASS2["pass2:①② 均落空才等全量收敛重查<br/>(ensureScanned,PR5 主路径首查不等这里)<br/>③ 反向形态:子类 MRO 反查 enclosing(精确身份)"]
  SHD["kode2 shadow 对拍腿:shadowCompareDefinition<br/>languageProviders.ts:1267(fire-and-forget,不改返回值)"]
  END2["operation.end(hit|miss) → Location 或 Location 列表或 null"]

  VC2 --> M2 --> AD2 --> TR --> CTX
  CTX -- "skip" --> END2
  CTX -- "代码位" --> KBE
  KBE -- "命中" --> STUB --> END2
  KBE -- "否" --> CB
  CB -- "kbe from-import" --> CB1 --> END2
  CB -- "显式 import 基类" --> CB2 --> END2
  CB -- "实体基类" --> CB3 --> END2
  CB -- "否" --> REV --> L0
  L0 -- "段命中候选" --> L1
  L0 -- "落空" --> END2
  L1 --> TY
  TY --> MRO
  MRO -- "①② 任一命中" --> END2
  MRO -- "①② 落空" --> PASS2 --> END2
  AD2 -.->|对拍| SHD

  WAITB("等待点 B:withInitialScanTimeout 5s<br/>languageProviders.ts:4198,层1 属性命中后补类型信息时")
  WAITC("等待点 C:ensureCompositionRoots joinWait<br/>组合根未就绪时等待构建(pythonClassIndex.ts:624,打点 :576)")
  WAITD("等待点 D:pass2 await ensureScanned<br/>①② 均落空才等全量收敛——PR5 主路径首查不等这里")
  L1 -.->|等待| WAITB
  MRO -.->|等待| WAITC
  PASS2 -.->|等待| WAITD
  SCAN -.->|后台| MRO

  classDef waitPoint fill:#fff3cd,stroke:#d97706,stroke-dasharray:5 4;
  class WAITB,WAITC,WAITD waitPoint;
```

### 7.3 Completion(Python self./kbe. 两语境)

```mermaid
flowchart TD
  VC3["VS Code: provideCompletionItems(document, position)"]
  M3["extension.ts:500 打点 startLanguageServiceOperation('completion')<br/>(另一语境 :911)"]
  CP["PythonCompletionProvider.provideCompletionItems<br/>languageProviders.ts:5029"]
  KBEC{"kbe./KBEngine. 模块语境?<br/>(已引入/已用别名)"}
  FILTER["filterKbeSymbols 前缀过滤 :4921<br/>(engineApiMetadata 目录)"]
  SELFC{"self. 语境?<br/>getPythonSelfCompletionContext :4935"}
  MAP["EntityMappingManager.getMappingForPythonFile :4942<br/>(PR4 semanticIndex 兼容查询层,纯内存快照)"]
  NOMAP["mapping 未命中 → return null<br/>(让位 Pylance 等通用补全)"]
  PROPS["mapping.properties 平铺/嵌套属性枚举<br/>+ 引擎 API 面合并"]
  END3["operation.end(ok|miss) → CompletionItem 列表或 null"]

  VC3 --> M3 --> CP --> KBEC
  KBEC -- "是" --> FILTER --> END3
  KBEC -- "否" --> SELFC
  SELFC -- "否" --> END3
  SELFC -- "是" --> MAP
  MAP -- "无映射" --> NOMAP --> END3
  MAP -- "命中" --> PROPS --> END3

  WAITE("等待点 E:补全链无显式预算闸;<br/>getMappingForPythonFile 为纯内存查询<br/>(首扫在途时可能返回部分映射,不阻塞)")
  MAP -.->|查询| WAITE

  classDef waitPoint fill:#fff3cd,stroke:#d97706,stroke-dasharray:5 4;
  class WAITE waitPoint;
```

### 7.4 Diagnostics(.def / entities.xml,PR6 版本化调度)

```mermaid
flowchart TD
  CHG["VS Code: onDidChangeTextDocument"]
  WATCH["extension.ts:961 文档事件适配<br/>(onSave/onOpen 同通道)"]
  RQ["DiagnosticScheduler.requestQueued<br/>diagnosticScheduler.ts:211"]
  CO["同 URI 只留最新版本任务<br/>旧版本记 coalescedStale 永不执行"]
  FL["flushQueued(单轮 25ms 时间片,IDE-DIA-006)<br/>extension.ts:990 → diagnosticScheduler.ts:241"]
  VG{"版本令牌守卫:<br/>任务版本 == 文档当前版本?"}
  DROP["staleDropped 丢弃,不发布"]
  GEN{"同版本+同诊断输入代<br/>已发布?(A6-2 零重算)"}
  SKIP["skippedCurrentVersion 跳过"]
  CALC["computeAndPublish<br/>def 侧打点 extension.ts:316 / entities 侧 :329"]
  VD["validateDocument(languageProviders.ts:1326)<br/>parseDefAst 一次结果共用标量+结构校验(languageProviders.ts:1341,批92)"]
  VEX["validateEntitiesXmlDocument(languageProviders.ts:1359)<br/>documentStore 'entities-analysis' 命名空间缓存(languageProviders.ts:1372,A6-3)"]
  SHDD["kode2 shadow 对拍+语料镜像腿<br/>shadowObserveDefDocument(:1295,fire-and-forget)"]
  DS["文档解析(document-parse 打点)<br/>documentStore 同版本只解析一次(PR2)"]
  PUB["diagnostics.set(uri, items) 发布"]
  CFG2["配置切换 setEnabled/invalidateAll<br/>(diagnosticScheduler.ts:159 / :178)generation+1 → 已发布文档全部重算(A6-4)"]

  CHG --> WATCH --> RQ --> CO --> FL --> VG
  VG -- "版本已前进" --> DROP
  VG -- "当前版本" --> GEN
  GEN -- "已发布" --> SKIP
  GEN -- "需重算" --> CALC
  CALC --> VD
  CALC --> VEX
  VD --> DS
  VEX --> DS
  DS --> PUB
  VD -.->|对拍| SHDD
  CFG2 -.->|失效| GEN

  WAITF("等待点 F:排队合并是唯一缓冲——<br/>编辑风暴中同 URI 后一版本顶掉前一版本,<br/>无固定延时;计算本身同步(毫秒级,见 S4)")
  CO -.->|排队| WAITF

  classDef waitPoint fill:#fff3cd,stroke:#d97706,stroke-dasharray:5 4;
  class WAITF waitPoint;
```
