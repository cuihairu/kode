# KB-001 · 头号专题 · 内存对象引用与释放坑集（中文版）

> 归属：KB-001「KBEngine 源码解析知识库」**首批头号专题**（用户点名的重灾区，2026-11-01）
> 语言：en / zh 双语（英文版见 [`memory-references.en.md`](./memory-references.en.md)）
> 配套机制文档：实体生命周期（创建→cell 迁移→销毁），见 [`../entity-lifecycle/`](../entity-lifecycle/)
>
> **写作原则**：每坑按「现象 → 根因（带 kbe/src 源码引用，无引用的标 TODO 待验证）→ 正确姿势」三段整理。根因用 CPython 引用计数语义解释，KBEngine 侧的托管行为依据只写仓内 `docs` 与 def 模型里**查得到的**；查不到的明确标 TODO，不编造。

## 目录

- [§0 CPython 地基：为什么这个坑集成立](#0-cpython-地基为什么这个坑集成立)
- [§1 坑一类：生命周期引用（实体不是对象，是一段被引擎管理的生命）](#1-坑一类生命周期引用)
- [§2 坑二类：cell/base 迁移后的引用失效](#2-坑二类cellbase-迁移后的引用失效)
- [§3 坑三类：destroy 后仍持有引用](#3-坑三类destroy-后仍持有引用)
- [§4 坑四类：timer / Functor 持引用](#4-坑四类timer--functor-持引用)
- [§5 坑五类：cellData 快照 vs 活对象](#5-坑五类celldata-快照-vs-活对象)
- [§6 待验证清单（汇总所有 TODO）](#6-待验证清单汇总所有-todo)
- [§7 证据来源](#7-证据来源)

---

## 0. CPython 地基：为什么这个坑集成立

KBEngine 的脚本层是 CPython。CPython 的内存释放靠**引用计数 + 循环垃圾回收**两条线：

- **引用计数归零即释放**：一个 PyObject 没有任何人持有强引用，立刻析构（Py_DECREF 链）。这是最主流、也最容易制造「僵尸」的路径——只要有人忘记 drop 一个强引用，对象就永远活着。
- **循环垃圾回收**只处理**引用环**（对象互相指、没有外部入口）。纯的引用环最终也会被 GC 回收，但时机不可控。

KBEngine 在此之上做了一层**托管**：实体不是裸 Python 对象，而是被引擎按 `id` 登记在 `entities` 字典里的对象。引擎可以「销毁」一个实体（从字典摘除、标记 `isDestroyed`、不再分发逻辑事件），但**只要你的 Python 代码还持有它的强引用，这个 Python 对象就按引用计数继续活在堆里**——引擎的「销毁」语义和 Python 的「释放」语义是两回事，本坑集的全部五类问题都从这个错位长出来。

> CPython 引用计数 / GC 的逐行机制，KB-001 决定**不重写**，直接交叉引用 hello-python 仓 `docs/internals/` 的源码级分析（object-model / memory-management / gc-module / type-system / eval-loop 等 10 篇，2026-11-01 盘点）。本篇只把 CPython 语义当作既知前提来用。

---

## 1. 坑一类：生命周期引用

### 现象

把一个实体对象存进另一个实体的属性 / 全局 dict / 模块级列表后，发现被引用的实体「明明 destroy 了却还在被调用」「self.xxx.isDestroyed 已经是 True 但方法还能跑」。

### 根因

**「实体」在 KBEngine 里是引擎管理的一段生命，不是「拿到对象就拥有对象」。**

- 引擎把实体按 `id` 登记在 `entities`（`lib/entitydef/entities.h:22、:128`，注册点 `lib/server/entity_app.h:411`）。`KBEngine.entities` 这个模块属性在 baseapp / cellapp 都是 `entities`（`entity_app.h:411`）。
- `destroy()` 做的是引擎语义：摘除登记、置 `isDestroyed=True`（`lib/entitydef/entity_macro.h:34`，宏块同 `:33-35`）、停止逻辑事件分发。
- 你属性里存的是**强引用**（普通 Python 赋值 `self.friend = other` 就是一次 `incref`）。引擎摘登记不会替你 `decref`。于是这个 Python 对象在堆里继续活着，`other.someMethod()` 照样能跑——只是引擎不再管它。

引擎侧「实体被引用」的精确语义（引擎是否还提供 `__del__` 钩子、是否有弱引用机制）仓内分析未覆盖，标 **TODO 待验证**。

### 正确姿势

1. **跨实体关系用 id 不用对象**：`self.friendID = other.id`；要用时再 `KBEngine.entities.get(self.friendID)`。拿不到（被 destroy / 未加载）就是 None，天然表达「关系已失效」。
2. **必须持对象时，用前查 `isDestroyed`**（`entity_macro.h:34`）：
   ```python
   friend = self.friend
   if friend is not None and not friend.isDestroyed:
       friend.onSomeEvent(...)
   ```
3. **销毁点主动清引用**：在 `onDestroy`（cell 侧 `server/cellapp/entity.cpp:209`）里把 `self.friend = None`、从全局列表摘除，让引用计数归零。
4. （C-23 已规划 `destroyed-entity-reference` lint 规则，把「对已 destroy 实体的常见引用模式」静态检测出来——见 `todo.md` C-23 交付②。）

---

## 2. 坑二类：cell/base 迁移后的引用失效

### 现象

cell 实体跨 cellapp 迁移（或 teleport）后，base 侧缓存的 `self.cell` 句柄、或别处存的 cell 对象引用「发不出调用 / 调用落到旧地址 / 抛异常」。

### 根因

`self.cell` / `self.base` 不是实体对象，是 **EntityCall 句柄**——进程间通信的远程代理：

- base 侧 `cell` getter：`pyGetCellEntityCall`，`server/baseapp/entity.cpp:36`，返回 EntityCall 句柄。
- cell 侧 `base` getter：`server/cellapp/entity.cpp:74`。
- 引擎里只有一种脚本类型 `EntityCall`（`lib/entitydef/entity_call.h:15`）；base/cell/client 之别是内部枚举 `ENTITYCALL_TYPE`（`lib/common/common.h:283-291`），Python 类型层没有 `BaseEntityCall/CellEntityCall/ClientEntityCall` 三个子类（`docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` 偏差清单 #2，双证）。

迁移的本质是**实体搬了进程、换了通信地址**。`onRestore()`（`server/cellapp/entity.cpp:3868`）是 cell 在新 cellapp 上重建的时刻；**旧句柄指向的是旧地址**。引擎是否在迁移时主动作废旧 EntityCall（置空 / 改指新地址）仓内分析未覆盖，标 **TODO 待验证**——但无论如何，安全模型都一样：迁移后你**不该假定任何迁移前缓存的 EntityCall 仍指向活实体**。

### 正确姿势

1. **不要跨帧缓存 `self.cell` / `self.base` 到长寿命属性里**。要用就现取：`self.cell.someMethod()`。
2. **迁移敏感的状态在 `onRestore` 里重建**（`server/cellapp/entity.cpp:3868`）。
3. **跨进程交互前先确认对端还在**：migration 完成后用 `onGetCell`（base 侧，`server/baseapp/entity.cpp:1032`）确认新 cell 已就绪，再走调用。

---

## 3. 坑三类：destroy 后仍持有引用

### 现象

`entity.destroy()` 之后，别的实体存的 `self.target = entity` 这个 `target` 还能调方法、改属性，看起来像「销毁没生效」；更隐蔽的是因此引起的内存只增不减（对象永不释放）。

### 根因

`destroy(deleteFromDB=False, writeToDB=False)`（`lib/entitydef/entity_macro.h:20`，kwargs 名单 `server/baseapp/entity.cpp:626-632、657-658`）的语义见 §1：引擎摘登记 + 置 `isDestroyed`，**不会替你清 Python 引用**。

所以两类后果：

1. **「僵尸调用」**：你拿到的是活对象（引用计数 > 0），调方法不会报错，但引擎层逻辑（视野、timer、持久化、事件分发）已不把它当实体。
2. **内存泄漏**：只要强引用链不断，对象就永不释放。如果销毁的实体很多、又都被某处长期持有，堆会一直涨。

引擎是否在 destroy 时清空实体上的 def 属性 / 组件引用（以打破内部引用环）仓内分析未覆盖，标 **TODO 待验证**。但无论引擎清不清，**你自己的引用必须自己清**。

### 正确姿势

1. 同 §1：跨实体一律存 id，用 `KBEngine.entities.get(id)` 现取，取不到即视为已销毁。
2. `onDestroy`（cell 侧 `server/cellapp/entity.cpp:209`）里清掉本实体持有的所有对外强引用（含组件引用、全局注册）。
3. 必须持有对象引用时，调用前判 `isDestroyed`（`entity_macro.h:34`）。

---

## 4. 坑四类：timer / Functor 持引用

### 现象

给实体 `addTimer` 后，即便实体 destroy 了，timer 回调仍会触发；或回调是个闭包 / 绑定方法，闭包里捕获的实体一直不释放。

### 根因

timer 是引擎层的调度对象，句柄由 `addTimer` / `delTimer` 管理：

- 实体级 `addTimer(initialOffset, repeatOffset=0.0, userArg=0)` / `delTimer(id)`（`lib/entitydef/entity_macro.h:17-18`；实现 `:1387-1405`、`:1407-1420`）。
- timer 到期回调实体 `onTimer(timerHandle, userData)`（base 侧 `server/baseapp/entity.cpp:1656`，cell 侧 `server/cellapp/entity.cpp:4322`；实参形态 `(timerID, intptr(pUser))` 见 `entity_macro.h:1363`）。
- 模块级 `addTimer(initialOffset, repeatOffset, callbackObj)`（`lib/server/python_app.cpp:329`，实现 `:721-726`，恰 3 参 `"ffO"`）；且 **baseapp/cellapp 模块根本没注册模块级 addTimer**（`server/baseapp/baseapp.cpp:429-451`、`server/cellapp/cellapp.cpp:172-189` 无此项）——模块级 addTimer 只在 pythonapp 系（dbmgr/loginapp/interfaces/logger）可用（VALIDATION_REPORT 偏差清单）。
- `delTimer` 源码返回 int（`python_app.cpp:766-771`），失败返回 -1。

**关键错位**：timer 回调的分发以**引擎是否还认为实体活着**为准，不是以「对象的 Python 引用是否还在」为准。实体 destroy 后引擎不再分发给该实体（timer 随实体销毁而失效这条引擎链路的精确行为仓内分析未覆盖，标 **TODO 待验证**）；但**回调对象是闭包 / 绑定方法时，闭包捕获的强引用不受 timer 失效影响**——只要别处还拿着这个闭包，被捕获的实体就不释放。

### 正确姿势

1. **重复 timer 必须在 `onDestroy` 里 `delTimer(handle)` 注销**。addTimer 返回的句柄要存好；C-23 已规划 `timer-leak-on-destroy` lint 规则（addTimer 句柄未在 onDestroy 注销的模式检测），见 `todo.md` C-23 交付②。
2. **回调避免闭包捕获长寿命实体**；非捕获不可时，在 `onDestroy` 里把闭包置 None / 从注册表摘除。
3. 模块级定时需求（跨实体、不挂在某个实体上）用 pythonapp 系进程的模块级 addTimer；挂在 baseapp/cellapp 进程就要认清「模块级 addTimer 不存在」这个源码事实（VALIDATION_REPORT 偏差清单）。

---

## 5. 坑五类：cellData 快照 vs 活对象

### 现象

在 `onWriteToDB(cellData)` 里改了 `cellData` 的字段，以为改到了 cell 实体的真实属性；或把 `cellData` 存起来以为它代表「当前的 cell」。

### 根因

`cellData` 是**引擎在写库时刻构造的一份数据快照**，不是 cell 实体对象：

- `cellData` 在 `ENTITY_LIMITED_PROPERTYS` 系统保留属性名单里（`lib/entitydef/common.h:124-157`，名单含 `cellData`：同文件 `:82` 行区域），是 def 禁止重定义的系统属性，位置/朝向走别名注入（`common.h:118-121`）。
- base 侧 `onWriteToDB(cellData)` 带 `cellData` 参数（`docs/reference/kbengine-typings-2026-10-21/_KBEngine_hooks.pyi:91`，BaseEntityHooks）；cell 侧 `onWriteToDB()` **无参数**（同文件 `:119`，CellEntityHooks）。两侧签名差异本身就说明：base 侧的 cellData 是**从 cell 侧带过来的一份数据**，不是 base 实体自己的属性。
- cell 侧写库回调 `server/cellapp/entity.cpp:1259`。

「快照在何时构造、是否就是 cell 实体属性的浅拷贝」这一层机制仓内分析未覆盖，标 **TODO 待验证**；但无论实现细节如何，**语义上它是写库时刻的数据副本，改了不影响 cell 实体本体**。

### 正确姿势

1. `onWriteToDB(cellData)` 里把它当只读数据源用；要改持久化值，改 cell 实体属性（让它在下次同步/写库时生效），或明确这是「本次写库我要额外塞进去的值」的语义（TODO 待验证：引擎是否回读回调里改过的 cellData）。
2. 不要把 `cellData` 当活实体长期持有；它只是这一次的写库快照。

---

## 6. 待验证清单（汇总所有 TODO）

| # | 待验证点 | 出现位置 | 需要的源码依据 |
|---|---|---|---|
| 1 | 引擎是否提供实体弱引用 / `__del__` 钩子 | §1 根因 | entity 析构路径（entity_macro.h / pyscript 绑定） |
| 2 | 引擎在 cell 迁移时是否主动作废旧 EntityCall | §2 根因 | entity_call.cpp 迁移处理 + onRestore 链路 |
| 3 | base destroy → cell 销毁的完整调用链 | 生命周期文档 §3.1 | baseapp/entity.cpp destroy 实现 |
| 4 | base 侧 onDestroy 的具体调用行号 | 生命周期文档 §3.2 / §4.1 | baseapp 实体销毁路径 |
| 5 | 引擎 destroy 时是否清空实体 def 属性 / 组件引用（破引用环） | §3 根因 | 实体析构/属性清理路径 |
| 6 | 实体 destroy 后 timer 失效的精确引擎行为 | §4 根因 | entity_macro.h addTimer/delTimer 与销毁路径的交互 |
| 7 | cellData 快照的构造时机/拷贝深度、onWriteToDB 改 cellData 是否回读 | §5 根因 | baseapp/entity.cpp 写库路径 + cellData 打包逻辑 |
| 8 | def 属性在 `__init__` 前注入的逐行机制 | 生命周期文档 §1.1 | KBEngine Python 绑定层（扩展域①） |

---

## 7. 证据来源

仓内可直接核对的分析产物（本篇引用的行号均出自这些文档的源码取证）：

- `docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` —— typings 逐条对照 kbe/src 的核验报告（addTimer/delTimer/EntityCall 子类/cellData/onWriteToDB 两侧签名等偏差与调用点）
- `docs/reference/kbengine-typings-2026-10-21/_KBEngine_hooks.pyi` —— 生命周期 hook 签名（含 onWriteToDB 的 cellData 参数差异）
- `docs/review/2026-10-21-entity-builtin-properties.md` —— Entity 内建属性按组件分面取证（cell/base/isDestroyed/cellData 系统保留名单）
- `docs/source-analysis.md` —— entitydef 装载链与三侧存在性判定
- `todo.md` KB-001 / C-23 条目 —— 头号专题定位、后续 lint 规则（destroyed-entity-reference / timer-leak-on-destroy）规划

引擎源码本体（`kbe/src/...`）不在 kode 仓内；上述仓内文档基于用户本地 KBEngine 检出产出。本篇所有 TODO 待验证项，均需对照引擎源码补证，**不以猜测补全**。
