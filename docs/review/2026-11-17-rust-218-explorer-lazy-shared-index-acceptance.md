# RUST-218 验收纪要:Project Explorer 惰性加载与实体/组件/类型/脚本共享 Core 索引

日期:2026-11-17。本纪要对账 RUST-218(旧 UI-001,主 todo 排队项)的验收口径与既有交付证据。结论:**惰性加载与共享索引均为既有交付形态,本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| lazy-load | entityExplorer 树惰性展开:根层 `getChildren(undefined)` 只回分组项(`getRootGroups`),展开分组才取该 category 条目(`getDefinitionItems`),展开条目才构造 summary+sections——VS Code TreeProvider 惰性契约逐层兑现,无全量预构建 | `src/explorerProviders.ts:97-140` |
| 实体/组件/类型视图 | `kbengine.entityExplorer` 单视图四 category 分组:'type'/'entity'/'interface'/'component'(DefinitionCategory),条目视图模型统一走 buildDefinitionViewModel | `src/definitionWorkspace.ts:51`;package.json contributes.views |
| 共享 Core 索引 | 数据面=definitionWorkspace(`getDefinitionEntries`/`getWorkspaceRootForDocument`)+definitionSemantics loader——与 hover/definition/references/诊断同一共享语义层(Rust Core 语义面同源,RUST-137/138/139 语料同构);多 root 经 RUST-069-W 根注册表+`getWorkspaceRootForDocument` 前缀匹配 | `src/explorerProviders.ts:4-25`(imports);RUST-186 对账纪要 |
| 脚本视图 | 启动入口脚本面:`kbengine.start` 视图(startEntry)入口脚本由 def 扫描面派生(telnet derive_targets def_scan_roots+entry_scripts 直传),与 def 索引同源 | `src/startEntry.ts`;`tests/telnetDeriveTargets.test.ts:106`(def_scan_roots+entry_scripts 直传注记) |

## 本批增量

- 零代码增量:惰性分层、四 category、共享语义层均有既有钉(explorerProviders 套件+definitionWorkspace 消费面),再造属仪式性重复。

## 诚实条款

- 「脚本视图」的形态是**启动入口脚本面**(startEntry,def 扫描派生入口),不是全量 scripts 目录浏览树;若需要全量脚本浏览器,属新视图需求另批。
- 「共享 Core 索引」当前语义层由 TS definitionWorkspace/definitionSemantics 承载(Rust Core 语义面经 kodeCoreClient 接入、TS 兜底冻结保留,RUST-137+ 逐面收编中);「共享」指单一数据源多消费面,不是「索引已全部在 Rust」——收编进度见精确性主车道与 B1 战役台账。
