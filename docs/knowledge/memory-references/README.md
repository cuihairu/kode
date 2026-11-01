# KB-001 · 头号专题 · 内存对象引用与释放坑集（目录索引）

> 归属：KB-001「KBEngine 源码解析知识库」首批头号专题（用户点名重灾区，2026-11-01）
> 本目录收录五类内存坑，逐坑按「现象 → 根因（kbe/src 源码引用 / TODO 待验证）→ 正确姿势」整理。

## 文件

| 语言 | 文件 |
|------|------|
| 中文 | [`memory-references.zh.md`](./memory-references.zh.md) |
| English | [`memory-references.en.md`](./memory-references.en.md) |

## 五类坑一览

| # | 坑类 | 一句话 | 核心根因 |
|---|------|--------|----------|
| 1 | 生命周期引用 | 把实体对象存进别处后，destroy 了还被调用 | 实体是引擎管理的生命，不是「拿到就拥有」；强引用不会随引擎摘登记而释放 |
| 2 | cell/base 迁移后引用失效 | 迁移后缓存的 `self.cell`/`self.base` 句柄发不出调用 | 句柄是 EntityCall 远程代理，迁移=换地址 |
| 3 | destroy 后持引用 | destroy 后对象仍能跑方法、内存只增 | 引擎摘登记+置 isDestroyed，不替你清 Python 引用 |
| 4 | timer/Functor 持引用 | destroy 后 timer 仍回调、闭包捕获的实体不释放 | timer 分发看引擎是否还认为实体活着；闭包强引用独立于 timer 失效 |
| 5 | cellData 快照 vs 活对象 | 改 cellData 字段以为改到了 cell 实体 | cellData 是写库时刻的数据快照，非活实体 |

> 每坑的完整「现象/根因/正确姿势」与源码行号见上表对应语言文件。所有仓内查不到的引擎行为一律标 `TODO 待验证`，不编造。
