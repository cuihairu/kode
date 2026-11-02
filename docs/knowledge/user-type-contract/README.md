# KB-001 · 引擎机制 04 — 用户类型三契约与数据流方向（目录索引）

> 归属：KB-001「KBEngine 源码解析知识库（双语，人机共用）」第三批 · 引擎机制文档
> 专题：FIXED_DICT implementedBy 三契约 / 属性 Flags 同步方向 / 方法段调用方向
> 语言：en / zh（双文件同构）
> 依据：官方 KBEngine 在线源码 `kbe/src`（用户本地 `~/workspaces/kbengine` 本机缺失）+ kode 仓内源码级分析产物。凡未能核实的点一律标注 `TODO 待验证`，不编造行号。

## 双语文件索引

| 语言 | 文件 |
|------|------|
| 中文 | [`user-type-contract.zh.md`](./user-type-contract.zh.md) |
| English | [`user-type-contract.en.md`](./user-type-contract.en.md) |

## 文档结构

本专题回答两个核心问题：**用户自定义类型（FIXED_DICT + implementedBy）必须满足哪三份契约、缺一个为什么引擎起不来**；**属性/方法的数据流方向由什么决定——为什么在错误进程访问属性或跨进程调用方向错会失败**。

覆盖：

1. 三契约（`createObjFromDict` / `getDictFromObj` / `isSameType`，`datatype.cpp:2385-2404`）与缺一即启动注册失败的链路
2. PYTHON 跨网络 = pickle（`PythonType::addToStream` → `script::Pickler::pickle`）
3. 序列化实现 = 实例⇄dict（`impl_getDictFromObj` `datatype.cpp:2437`）；持久化同线带 `onlyPersistents`
4. 属性 Flags（`BASE` / `CELL_*` / `ALL_CLIENTS` / `OWN_CLIENTS` / `OTHER_CLIENTS`）如何决定同步方向——逐 Flag 一行「谁有谁没有」
5. 方法段（`BaseMethods` / `CellMethods` / `ClientMethods`）如何决定调用方向（domain 写死）
6. 方向图 baseapp↔cellapp→clients
7. 每个方向规则的 file:line 源码证据总表
8. 开发者常犯错误清单（在错误进程访问属性 / 跨进程调用方向错）

## 关键结论速查

- **三契约缺一 = 启动失败**，无运行时降级：`setImplModule` 任一方法取不到即 `return false` → `DataTypes::initialize` 失败 → 各进程起不来。
- **属性归属看 Flag 的位组合**，不是三选一：一个属性可同时注册进 baseapp / cellapp / client（`entitydef.cpp:1287-1297`）。
- **方法 direction 写死在 `.def` 段名里**：段 → domain（`CELLAPP_TYPE` / `BASEAPP_TYPE` / `CLIENT_TYPE`），运行时各进程只查自己那张表；方向错了是「查不到」而非「被拒绝」。
- **客户端能调的 cell 方法必须带 `Exposed`**，否则 `not is exposed, call is illegal!` 丢弃。
- **base↔cell 只有方法调用是真正双向**；属性是 cell → base 的单向快照（cellData）。

## 与既有专题的关系

- [持久化流程](../persistence-flow/README.md)：本篇 §1.4 的 `onlyPersistents` 与 cellData 快照是同一机制在数据形状上的体现。
- [内存坑集](../memory-references/README.md)：EntityCall 是远程代理，本篇 base↔cell 方法调用方向依赖该结论。
- [实体生命周期](../entity-lifecycle/README.md)：cell 迁移对方向的影响（迁移后 EntityCall 失效）见该篇。
