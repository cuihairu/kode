# 引擎机制 02 · 定时器与消息机制（timer 语义 / 精度 / bundle 机制）

> KB-001 知识库第二批 · 引擎机制文档 · 中文版（英文版见 [`timer-messages.en.md`](./timer-messages.en.md)）
>
> **证据规则**：本篇所有引擎行为结论都带 `kbe/src` 源码引用（`file:line`）。引用的第一来源是 kode 仓内已有的源码级分析产物（见文末「证据来源」）；仓内分析未覆盖的行为标注 `TODO 待验证`，待对照引擎源码后补——**宁缺毋假，不编造**。

---

## 0. 阅读地图

| 你想知道 | 直接跳 |
|---|---|
| addTimer / delTimer 有哪几张注册面 | §1 |
| timer 参数语义、onTimer 实参形态 | §2.1 |
| timer 精度能指望多少 | §2.2 |
| timer 与实体销毁的关系 | §2.3 |
| 线上字节怎么编码（MemoryStream） | §3.1 |
| 消息帧 / bundle 层格式 | §3.2 |
| 方法调用、属性更新的帧结构 | §3.3 / §3.4 |

## 1. timer 的三张注册面

同名 `addTimer` 在引擎里有**三张不同的注册面**，签名与可用进程都不同——混用是高频坑：

### 1.1 实体级（Entity.addTimer / delTimer）

| API | 签名 | 源码 |
|---|---|---|
| `self.addTimer(initialOffset, repeatOffset=0.0, userArg=0)` | 1-3 参，返回 timer 句柄 | `lib/entitydef/entity_macro.h:17`（`DECLARE_PY_MOTHOD_ARG3`，宏定义 `lib/pyscript/py_macros.h:228`）；实现 `entity_macro.h:1387-1405` |
| `self.delTimer(id)` | 接受 int 句柄或 `"All"` 字符串 | `lib/entitydef/entity_macro.h:18`；实现 `:1407-1420` |

base 侧与 cell 侧实体各有一套（两段生命各自的 timer）。客户端侧（bots 进程的 Entity）也有同名对：`lib/client_lib/entity.cpp:32-33`。

回调触发点：`onTimer(timerHandle, userData)` —— base 侧 `server/baseapp/entity.cpp:1656`，cell 侧 `server/cellapp/entity.cpp:4322`；引擎实参形态 `(timerID, intptr(pUser))` 见 `entity_macro.h:1363`。

### 1.2 组件级（EntityComponent.addTimer / delTimer）

`EntityComponent` 上有独立的同名对（`server/baseapp/entity_component.cpp:10-11`）——挂在组件生命周期上，不是宿主实体的。

### 1.3 模块级（KBEngine.addTimer —— pythonapp 系专属）

| API | 签名 | 源码 |
|---|---|---|
| `KBEngine.addTimer(initialOffset, repeatOffset, callbackObj)` | **恰 3 参** `"ffO"`，无默认值，第 3 句为回调对象 | `lib/server/python_app.cpp:329`；实现 `:721-726` |
| `KBEngine.delTimer(id) -> int` | 返回 timerID，失败 -1 | `lib/server/python_app.cpp:330`；实现 `:755-771` |

**关键事实：模块级 addTimer 只在 pythonapp 系进程可用**（dbmgr / loginapp / interfaces / logger，公共注册区 `python_app.cpp:271-334`）；**baseapp / cellapp 模块根本没注册它**（`server/baseapp/baseapp.cpp:429-451`、`server/cellapp/cellapp.cpp:172-189` 均无此项——VALIDATION_REPORT 偏差清单）。在 base/cell 脚本里写 `KBEngine.addTimer(...)` 是 AttributeError。

## 2. timer 语义与精度

### 2.1 参数与回调语义

- `initialOffset`：首次触发延迟；`repeatOffset`：重复间隔；`userArg`：透传给 `onTimer` 第二参。
- 回调签名 `onTimer(timerHandle: int, userData: int)`（`_KBEngine_hooks.pyi:90`/:115）；引擎侧实参是 `(timerID, intptr(pUser))`（`entity_macro.h:1363`）——**userData 走 intptr 整数通道，不是任意 Python 对象**；传对象引用会发生什么属于绑定层细节，**TODO 待验证**。
- `repeatOffset=0` 表示一次性 timer（官方文档口径；源码行未单独取证，**TODO 待验证**）。

### 2.2 精度

- 参数单位是**秒**（float，`"ffO"` 解析面 `python_app.cpp:721-726`、实体级同款 float 面）。引擎按主循环帧驱动检查到期，timer 回调精度受帧周期限制——**调度器量化行为（最小粒度、到期检查在帧内的位置）仓内分析未覆盖，TODO 待验证**。
- baseapp 模块面有 `quantumPassedPercent() -> int`（`server/baseapp/baseapp.cpp:439`，实现 `:510-513`）返回当前帧进度百分比——佐证「帧/quantum」概念；quantum 长度配置项与 timer 精度的换算关系 **TODO 待验证**。

### 2.3 timer 与实体生命周期

- timer 回调分发以「引擎是否还认为实体活着」为准，不是「Python 引用是否还在」（首批结论，见[内存坑集 §4](../memory-references/memory-references.zh.md#4-坑四类timer--functor-持引用)）。实体 destroy 后引擎停止分发给它的精确链路 **TODO 待验证**。
- 正确姿势：重复 timer 在 `onDestroy` 里 `delTimer(handle)`；一次清全部用 `delTimer("All")`（`entity_macro.h:18` 实现 `:1407-1420` 接受 int 或 `"All"`）。C-23 已规划 `timer-leak-on-destroy` lint 规则。

## 3. 消息与 bundle 机制

### 3.1 底座：MemoryStream 字节布局

进程间一切消息最终落在这套字节布局上（全部**小端、定宽、无 varint**，`lib/common/memorystream.h`；kode 的 Rust 权威复刻 `crates/kode-server/src/wire_codec.rs` 逐条带源码出处）：

| 类型 | 布局 | 源码 |
|---|---|---|
| UINT8/16/32/64 | LE 1/2/4/8 字节 | `memorystream.h:259-281` |
| INT8/16/32/64 | LE 1/2/4/8 字节（ENTITY_ID 同宽 int32，`platform.h:342`） | `memorystream.h:283-305` |
| FLOAT / DOUBLE | IEEE754 LE 4/8 字节 | `memorystream.h:307-317`（datatype.cpp:540/:630） |
| BOOL | 1 字节 int8，非零→true | `memorystream.h:247-251` |
| STRING | 原始字节 + 0x00，无长度前缀；空串=单字节 0x00 | `memorystream.h:224-229` |
| UNICODE / BLOB / PYTHON / PY_DICT / PY_TUPLE / PY_LIST | u32 长度 + 字节（PYTHON* 是不透明 pickle 字节） | `memorystream.h:551-556`（appendBlob）；datatype.cpp:1129-1142、:1225-1229、:1288-1296、:1344-1352、:1400-1408 |
| ENTITYCALL | 16 字节定长：id i32 + component_id u64 + type u16 + script_uid u16 | `datatype.cpp:1512-1573`（宽度基准 `platform.h:345`） |

脚本侧同名 `MemoryStream` 类是这套布局的 Python 面（`lib/pyscript/py_memorystream.cpp:27-35`；`bytes()` 方法名而非 dunder，`:30`；rpos/wpos/fill `:31-33`、`:540-646`）。

### 3.2 bundle 层：消息帧格式

bundle 是把消息装帧 отправки的层（`lib/network/bundle.cpp`）：

- **帧头**：`msgid u16 + 长度 u16`；变长消息的长度字段 = **载荷长度（不含 4 字节帧头）**（`network/bundle.cpp:273-395`；枚举基准 `lib/common/common.h:88-92`）。
- **变长回填**：发送时才知道长度，先占位后回填 `currMsgLength_ - ID_SIZE - LENGTH_SIZE`（`bundle.cpp:346-347`）。
- **定长消息**：无长度字段，读固定 body（`bundle.cpp:304-309`）。
- **≥65535 扩展长帧**：长度字段写 65535，再后插 u32 真实长度（`bundle.cpp:358-371`）。
- Rust 侧对齐实现：`wire_codec.rs` `encode_message_frame` / `decode_message_frame`（`crates/kode-server/src/wire_codec.rs:1010-1054`），35 个黄金样本锁字节级一致（`crates/kode-server/tests/golden/wire-parity.json`）。

### 3.3 方法调用帧（暴露方法的远程调用）

`self.cell.X()` / `self.base.X()` / `self.client.X()` 最终编码为：

- **别名模式**：u8 componentPropertyAliasID（0=本实体）+ u8 methodAliasID + 实参（`lib/client_lib/entity.cpp:169-182`；实参无计数前缀，`entitydef/method.cpp:146-176`）。
- **utype 模式**：u16 methodUtype + 实参；component id 恒 0 不读流（`client_lib/entity.cpp:184-190`、`:170-181`）；方法 utype = uint16。

### 3.4 属性更新流（cell→client 同步的帧结构）

- **实体 ID**：全量 i32（`clientobjectbase.cpp:1113-1119` ENTITY_ID=int32）或别名 u8。
- **别名模式条目**：parent u8 + child u8；**utype 模式条目**：parent u16 + child u16（ENTITY_PROPERTY_UID=uint16，`lib/common/common.h:80`；属性 utype 按 def 解析序从 1，`entitydef/entitydef.cpp:1020-1094`）。
- 特殊基础属性 position/direction/spaceID：别名模式 id 1/2/3，utype 模式 40000/40001/40002。
- **全量快照按属性名字母序**（引擎 `getClientPropertyDescriptions` 是 std::map 有序容器）。

## 4. 待验证清单

| # | 待验证点 | 关联章节 | 需要的源码证据 |
|---|---|---|---|
| 1 | userArg 传 Python 对象引用时引擎如何持有/释放 | §2.1 | entity_macro.h addTimer 实现对第 3 句的 PyObject 持有策略 |
| 2 | repeatOffset=0 一次性语义的源码行 | §2.1 | timer 系统类（lib/server/timer.* 或等价）|
| 3 | timer 到期检查的调度器量化（帧内位置、最小粒度） | §2.2 | 主循环 + Timers::process |
| 4 | quantum 长度配置与 timer 精度换算 | §2.2 | baseapp 配置项 + gametime 实现 |
| 5 | 实体 destroy 后 timer 失效的精确引擎链路 | §2.3 | 实体销毁路径 × Timers 清理 |
| 6 | bundle 发送时机（攒包/flush 策略、每帧合并） | §3.2 | network/channel 发送队列 |
| 7 | msgid 分配表（哪些 id 归内部消息） | §3.2 | 消息表生成/注册代码 |
| 8 | 服务端间方法调用帧与 client 帧的差异（如有） | §3.3 | baseapp/cellapp 侧方法分发代码 |

## 5. 证据来源

仓内可直接核对的分析产物（本篇引用的行号均出自这些文档的源码取证）：

- `docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` —— addTimer 三张注册面、delTimer 返回值、模块级注册面缺失（偏差清单）
- `docs/reference/kbengine-typings-2026-10-21/_KBEngine_hooks.pyi` —— onTimer 签名
- `crates/kode-server/src/wire_codec.rs` —— C-15 Rust 权威 wire codec，逐字节复刻 memorystream.h / bundle.cpp / datatype.cpp / client_lib/entity.cpp，每条带 file:line provenance
- `crates/kode-server/tests/golden/wire-parity.json` —— 35 个黄金样本（字节级一致）
- `docs/features.md` C-15 条目 —— codec 范围与 provenance 汇总
- `docs/knowledge/memory-references/` —— timer/Functor 持引用坑（首批）
- `todo.md` KB-001 / C-23 条目 —— timer-leak-on-destroy lint 规划

引擎源码本体（`kbe/src/...`）不在 kode 仓内；上述仓内文档基于用户本地 KBEngine 检出（`~/workspaces/kbengine`）产出。仓内文档未覆盖的行为，本篇一律标 TODO 待验证。
