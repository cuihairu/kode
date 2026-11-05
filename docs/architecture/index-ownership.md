# 五索引所有权与版本失效契约（KODE-ARCH-003 · 2026-11-05）

> 条目原文：建立五索引（SemanticIndex/EntityMapping/PythonClassIndex/
> WorkspaceIndex/GlobalDataIndex）所有权与版本失效契约文档+断言。
>
> 本文描述当前代码事实；每条契约有对应断言（`tests/indexOwnershipContracts.test.ts`，
> 测试名以 `C-<系列>` 编号与本文对齐）。改动失效语义时必须同笔改本文与断言。

## 总则

- **所有权**：五索引都在 `activate()` 内构造（`src/extension.ts`），生命周期
  随扩展；谁构造谁 dispose，测试里 `finally { index.dispose(); }` 同口径。
- **失效总原则**：物理文件变更 → 各索引**精确裁断**受影响的派生层，只前进
  受影响层的版本代，不做全量重扫自愈（全量失效仅限根集切换/配置切换/关停面）。
- **在飞守卫**：任何异步任务的回包都要比对自己启动时的 generation/revision
  令牌，旧代回包不得覆盖新代（IDE-REV-001 / AUD-034 / AUD-071 同族纪律）。

## 1. SemanticIndex（`src/semanticIndex.ts`）

- **所有权**：`EntityMappingManager` 的私有实例（`entityMapping.ts:208`），
  经 `getSemanticIndex()` 暴露；模块级单例 `getSemanticIndex()`
  （semanticIndex.ts:368）是另一份共享类型注册表面，二者不混用。
- **数据面**：实体投影（name/defFile/pythonFiles/owners 五张索引 Map）+
  类型注册表快照（键 = 规范化根路径 + aliasDiscovery 开关）。
- **失效契约**：
  - C-S1 快照失效按 dependencies 精确裁断：`notifySemanticFilesChanged`
    只作废依赖命中变更文件的快照（semanticIndex.ts:313）。
  - C-S2 空变更数组 = 全量作废（文档化的逃生口，生产热路径不走）。
  - C-S3 `removeRoot` 整根摘除，键前缀含 `#` 分隔符，不误伤同前缀其他根
    （/ws/a vs /ws/ab），根描述符一并注销。
  - C-S4 快照 generation 严格单调（跨 store/失效只增不减）。
  - C-S5 同 defFile 重注册 = 替换（按 def 文件唯一归属），同名实体后注册
    覆盖（策略①）。

## 2. EntityMappingManager（`src/entityMapping.ts`）

- **所有权**：activate 构造（extension.ts:712，共享 IndexScheduler）；
  持有 def/python/types-registry 三 watcher + SharedFileEventMerger +
  依赖图；dispose 全部退订（entityMapping.ts:2591）。门控模式
  （`deferStartup: true`）构造零副作用，`ensureStartup()` 幂等接线。
- **数据面**：.def 实体映射索引（属性/方法/Python 绑定/调用图），
  SemanticIndex 投影同笔登记。
- **失效契约**：
  - C-E1 门控构造零副作用（不建 watcher、不入队首扫）——装配顺序自由。
  - C-E2 `removeRoot(rootPath)` 摘除该根下全部映射与外部 watcher 记账
    （isUnderRemovedRoot 前缀裁断）。
  - C-E3 def 变更 → 按 def 文件精确摘除（removeIndexByDefFile + 依赖图
    removeFile），不做全量重扫；无关文件不触发。
  - C-E4 未启动即可 dispose（幂等，无观察者泄漏）。

## 3. PythonClassIndex（`src/pythonClassIndex.ts`）

- **所有权**：activate 构造（extension.ts:1035，共享 IndexScheduler）。
- **数据面**：py 类/MRO/组合根；五轴版本代
  `classes/bases/methods/mro/compositionRoots`
  （`getIndexVersions()` 显式查询，pythonClassIndex.ts:224）。
- **失效契约**：
  - C-P1 未索引过的 .py 文件 invalidate = 无操作（发现期通知不得重启扫描）。
  - C-P2 全量 `invalidate()`（根切换/关停面）：classes/bases/methods/
    compositionRoots 各恰 +1，mro 经五轴循环与扫描复位各前进一次（共 +2，
    代码事实）。
  - C-P3 非 .py 文件变更：仅当依赖图记录在案（entities.xml/.def/types.xml/
    带实例赋值 py）才作废组合根；无记录文件五轴全不动。
  - C-P4 已索引 .py 单文件失效：仅 `classes`+`mro` 两轴前进（派生层精确
    裁断），单文件 revision 恰 +1。
  - C-P5 `syncDocumentParse` 同版本命中直接返回缓存对象（零解析）。

## 4. WorkspaceIndex（`src/workspaceIndex.ts`）

- **所有权**：activate 构造单例（extension.ts:1208，`sharedWorkspaceIndex`），
  按事件调用（`EventCallIndex`）面消费；watcher 先于发现挂（KR-AUD-27：
  初扫期间的变更经 revision 前进入索引不丢）。
- **数据面**：py 文件事件调用（addEvent/sendEvent 目标）缓存
  （路径 → IndexedFile），打开文档以缓冲区为准、保存/关闭自愈回盘。
- **失效契约**：
  - C-W1 惰性启动：未 start 即查询返回空且不建 watcher。
  - C-W2 dispose 幂等；dispose 后 `ensureStarted` 不再启动（watcher 数
    不增），缓存清空不复活。

## 5. GlobalDataDictIndex（`src/globalDataIndex.ts`）

- **所有权**：activate 构造（extension.ts:947，`dataDictIndex`）。
- **数据面**：`kbe.dataDict` 键值访问点索引（键签名 → 读/写点）+ 函数
  返回推导；按资产根作用域（`resolveScopeRoot`）。
- **失效契约**：
  - C-G1 根集世代 `generation`：`removeRoot`/`invalidate` 前进，在飞旧读
    不得发布旧根（AUD-071，globalDataIndex.ts:1501）。
  - C-G2 `invalidate()` 清空 byKey/cache/函数返回面后按当前根集重建；
    dispose 后 `invalidate()` 是无操作（不排重建、不留缓冲）。
  - C-G3 大文件编辑缓冲：收敛提交后 `editBufferEntryCountForTests()` 归零
    （AUD-076 合并窗不留残留）。

## 断言落点

`tests/indexOwnershipContracts.test.ts` —— 上述 C-* 编号一一对应 `it()` 标题
前缀；跑 `pnpm vitest run tests/indexOwnershipContracts.test.ts` 即验证。
