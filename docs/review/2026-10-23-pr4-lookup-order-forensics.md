# PR4 查找顺序取证与显式策略(2026-10-23)

<!-- 来源: todo.md A4-6「现有查找顺序取证:从测试提取当前命中顺序→固化为显式策略文档+测试(不改行为先锁)」。取证对象为 PR4 落地前 origin/main 的行为,全部口径已由 tests/semanticIndex.test.ts 锁定;语义索引(SemanticIndex)按本策略实现,EntityMappingManager 查询经其兼容层走同序。 -->

## 1. Python 文件 → 实体索引(findIndexForPythonFile,entityMapping.ts)

| 序 | 命中段 | 口径 | 锁定测试 |
|---|---|---|---|
| 1 | owner 归属文件精确匹配 | 规范化路径(小写斜杠)双侧比对,大小写不敏感;多实体同持一文件时取注册序首个 | 取证② / 取证②b(owner 匹配大小写不敏感断言) |
| 2 | 实体名回落 | `basename(file, '.py')` 原样大小写比对实体名,不规范化;大小写不符即 miss | 取证②b(cell/hero.py miss 断言) |

两段都 miss → 交上层(PythonClassIndex)兜底,负缓存落账。

## 2. 同名实体(mappingIndexes 同名覆盖)

- 实体名映射单一胜者:**后注册者覆盖先者**(既有 `Map.set` 口径),不合并、不告警。
- 冲突取证:语义索引 `findEntityConflicts(name)` 返回全根条目清单(胜者排首),供诊断/取证;不静默吞掉。
- 锁定测试:取证①。

## 3. 类名 / owner(kind+名)回溯

- 类名 → 实体:**先到先得**(注册序首个携带该 ownerName 的实体;既有 `[...values()].find` 扫描口径)。
- owner(kind+名)回溯:同为先到先得;接口/组件符号不单独建索引,回溯到引用它的实体索引。
- 锁定测试:取证③。

## 4. 多资产根模型(A4-5)

- 根登记:`registerRoot(规范化路径)` 幂等,稳定 rootID = 规范化路径;显式 order 按登记序(工作区根在前,外部资产根按 getIndexScanRoots 声明序),查询不依赖 Map 插入序。
- 文件归属根:最长前缀命中(嵌套资产根优先)。
- 扫描顺序(既有):`findFilesAcrossRoots` 按根序枚举 → 注册序 = 扫描序,故 §2/§3 的「先/后」由显式根序派生,可复现。
- 锁定测试:根模型三例 + 兼容层 rootId 取证断言。

## 5. 类型注册表(getCustomTypeInfos / resolveEntityAnnotationType)

- 解析链:内建直查 → types.xml 自定义类型 → alias.xml 类型(aliasDiscovery 开关,默认开)→ 链断/环/未知发 Any。
- 合并序:types 在前 alias 在后,整表按 name `localeCompare` 升序(既有行为,definitionWorkspaceBranches.test.ts 锁定)。
- PR4 变更仅在缓存方式:查询改纯内存快照(键 = 规范化根 + 开关),**逐次 statSync 指纹废除**;重建只由更新事件(`notifySemanticFilesChanged`,依赖文件精确裁断)驱动。返回值口径不变。

## 6. def 变更失效口径(A4-2)

- 旧:任何 .def 增删改 → 整表清空(全仓重建)。
- 新:依赖图(SemanticDependencyGraph)出定向计划——失效集 = 变更文件 ∪ 记录在案依赖者反向闭包(子 .def 经父链/接口/组件边);类型文件变更另置注册表失效位;`fullRebuild` 恒 false。「无归属」负缓存仍整体让位(集合小,且新 .def 可能补上此前 miss)。
