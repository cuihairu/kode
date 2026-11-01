# KB-001 · 引擎机制 03 — 持久化流程（目录索引）

> 归属：KB-001「KBEngine 源码解析知识库（双语，人机共用）」第二批 · 引擎机制文档
> 专题：dbmgr 持久化 / 写回时机
> 语言：en / zh（双文件同构）
> 依据：kode 仓内源码级分析产物 + 官方 KBEngine 源码行号引用。凡仓内找不到证据的点一律标注 `TODO 待验证`，不编造。

## 双语文件索引

| 语言 | 文件 |
|------|------|
| 中文 | [`persistence-flow.zh.md`](./persistence-flow.zh.md) |
| English | [`persistence-flow.en.md`](./persistence-flow.en.md) |

## 文档结构

本专题回答一个核心问题：**一个实体从脚本侧发起持久化，到 dbmgr 真正落库，中间经过哪些时机与回调，写的是什么粒度**。

覆盖：

1. 脚本侧持久化入口（writeToDB / destroy(writeToDB) / deleteEntityByDBID / executeRawDatabaseCommand）
2. 写回时机（显式 / 销毁前 / 自动归档备份 / 关服）与写回粒度（整实体属性集）
3. 写库前 hook（onWriteToDB 两侧签名差异 / onPreArchive）
4. cellData 快照语义（快照非活实体、只读数据源）
5. 自动归档 / 自动备份（shouldAutoArchive / shouldAutoBackup）
6. 恢复与自动加载（shouldAutoLoad / onAutoLoadEntityCreate）
7. 待验证清单（8 项）与证据来源
