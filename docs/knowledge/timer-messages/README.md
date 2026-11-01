# KB-001 · 引擎机制 02 — 定时器与消息机制（目录索引）

> 归属：KB-001「KBEngine 源码解析知识库（双语，人机共用）」第二批 · 引擎机制文档
> 专题：timer 语义 / 精度 / bundle 机制
> 语言：en / zh（双文件同构）
> 依据：kode 仓内源码级分析产物 + 官方 KBEngine 源码行号引用。凡仓内找不到证据的点一律标注 `TODO 待验证`，不编造。

## 双语文件索引

| 语言 | 文件 |
|------|------|
| 中文 | [`timer-messages.zh.md`](./timer-messages.zh.md) |
| English | [`timer-messages.en.md`](./timer-messages.en.md) |

## 文档结构

本专题回答两个核心问题：**timer 有哪几张注册面、语义与精度边界在哪里**；**一次远程调用/属性同步在网络上长什么样**。

覆盖：

1. timer 三张注册面（实体级 / 组件级 / 模块级）与可用进程差异（模块级 addTimer 仅 pythonapp 系）
2. timer 参数语义（initialOffset / repeatOffset / userArg → onTimer(int, int)）与精度（帧驱动、quantum 关联）
3. timer 与实体生命周期的关系（onDestroy 注销、delTimer("All")）
4. MemoryStream 字节布局（小端定宽、无 varint；全类型表带源码行）
5. bundle 消息帧（msgid u16 + 变长/定长/扩展长）
6. 方法调用帧与属性更新流（别名/utype 双模式）
7. 待验证清单（8 项）与证据来源
