# KB-001 · 引擎机制文档 01 — Entity Lifecycle (创建 → Cell 迁移 → 销毁)

> 归属：KB-001「KBEngine 源码解析知识库（双语，人机共用）」首批头号专题 · 引擎机制文档
> 专题：实体生命周期（创建 → cell 迁移 → 销毁）
> 语言：en / zh（双文件同构）
> 依据：kode 仓内源码级分析产物 + 官方 KBEngine 源码行号引用。凡仓内找不到证据的点一律标注 `TODO 待验证`，不编造。

## 双语文件索引

| 语言 | 文件 |
|------|------|
| 中文 | [`entity-lifecycle.zh.md`](./entity-lifecycle.zh.md) |
| English | [`entity-lifecycle.en.md`](./entity-lifecycle.en.md) |

## 文档结构

本专题回答一个核心问题：**一个实体从脚本创建到被销毁，在 baseapp / cellapp / client 三侧分别经历哪些状态，每步由引擎哪个调用点驱动，脚本侧有哪些 hook 可以观察**。

覆盖：

1. 生命周期全景（base 侧与 cell 侧两段主线）
2. 创建入口：`createEntity` / `createCellEntity` / `createCellEntityInNewSpace` / `createEntityAnywhere`
3. 三侧存在性判定（hasBase / hasCell / hasClient）与 def 的关系
4. cell 迁移语义：onGetCell / onLoseCell / onRestore / onCreateCellFailure / teleport
5. 销毁路径：destroy(deleteFromDB, writeToDB) 与 onDestroy / onWriteToDB
6. 生命周期 hook 全表（BaseEntityHooks / CellEntityHooks / ProxyHooks）与源码调用点
7. 关键坑（供 KB-001 内存专题交叉引用）
