# KB-001 · KBEngine 源码解析知识库（双语，人机共用）

> 立项：`todo.md` KB-001 条目（P2 · 建设 · KBEngine 源码解析知识库）
> 定位：把历次分析 KBEngine 源码积累的知识结构化沉淀——不是会话记录，是可检索、可维护、喂给 hover/MCP 的资产。
> 结构：`docs/knowledge/`，双语 en+zh。

## 已交付（2026-11-01 首批 + 第二批；2026-11-02 第三批）

### 机制文档

| 专题 | 中文 | English |
|------|------|---------|
| 实体生命周期（创建 → cell 迁移 → 销毁） | [`entity-lifecycle/entity-lifecycle.zh.md`](./entity-lifecycle/entity-lifecycle.zh.md) | [`entity-lifecycle/entity-lifecycle.en.md`](./entity-lifecycle/entity-lifecycle.en.md) |
| 定时器与消息机制（timer 语义 / 精度 / bundle 机制） | [`timer-messages/timer-messages.zh.md`](./timer-messages/timer-messages.zh.md) | [`timer-messages/timer-messages.en.md`](./timer-messages/timer-messages.en.md) |
| 持久化流程（dbmgr 持久化 / 写回时机） | [`persistence-flow/persistence-flow.zh.md`](./persistence-flow/persistence-flow.zh.md) | [`persistence-flow/persistence-flow.en.md`](./persistence-flow/persistence-flow.en.md) |
| 用户类型三契约与数据流方向（implementedBy 三契约 / 属性 Flags / 方法段 direction） | [`user-type-contract/user-type-contract.zh.md`](./user-type-contract/user-type-contract.zh.md) | [`user-type-contract/user-type-contract.en.md`](./user-type-contract/user-type-contract.en.md) |

### 头号专题：内存对象引用与释放坑集（五类）

| 坑类 | 中文 | English |
|------|------|---------|
| 内存对象引用与释放坑集（五类：生命周期引用 / cell-base 迁移失效 / destroy 后持引用 / timer Functor 持引用 / cellData 快照 vs 活对象） | [`memory-references/memory-references.zh.md`](./memory-references/memory-references.zh.md) | [`memory-references/memory-references.en.md`](./memory-references/memory-references.en.md) |

## 知识源交叉引用（2026-11-01 盘点）

- **CPython 地基**：直接链接 hello-python `docs/internals/` 的 10 篇源码级分析（object-model / memory-management / gc-module / type-system / eval-loop 等），**不重写**。
- **KB-001 内存专题 = CPython 引用计数/GC × KBEngine 托管引用的交叉解释**（本批坑集遵循此口径）。

## 后续批次（扩展域）

1. KBEngine Python 绑定层源码分析（API 暴露机制 / entity 基类机制 / 属性 `__init__` 前赋值的引擎侧根因 / 脚本加载与热重载实现）
2. KBEngine C++ 进程内部（baseapp / cellapp / dbmgr 源码机制）
3. BigWorld-Engine-14.4.1 遗产源码（cell 机制血统）
4. 协议交互序列（握手 / 重连 / 迁移时序）
5. 历次会话分析结论收割（C-22 / C-23 已部分入账）

## 知识条目规范（供后续批次遵守）

- **每篇机制文档带源码位置引用**（`kbe/src` 文件:行），仓内分析覆盖不到的标 `TODO 待验证`，宁缺毋假。
- **双语同构**：每篇 en + zh 两份，中文为准 / 英文同义。
- **证据来源**：仓内 `docs/reference/kbengine-typings-2026-10-21/`（VALIDATION_REPORT / API_MATRIX）、`docs/review/2026-10-21-entity-builtin-properties.md`、`docs/source-analysis.md`。
- **可点击跳转**：源码引用最终喂给 hover/MCP（C-21 文档库 + MCP-001 explain/guide），见 todo.md KB-001 流水线。
