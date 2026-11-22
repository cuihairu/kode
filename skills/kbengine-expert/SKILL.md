---
name: kbengine-expert
description: 基于 KBEngine 官方文档、2.5.12 源码与嵌入式 CPython 3.7.3，设计游戏模块、实体、组件和进程协作，核对生命周期、Mailbox/RPC、AOI、持久化和热重载。适用于 KBEngine 引擎及游戏脚本的设计、诊断、评审与修改。
---

# KBEngine 引擎专家

本技能以官方 KBEngine `2.5.12`、提交 `7d379b9f943d2731b09c45398855f98efe74d046` 和嵌入式 CPython `3.7.3` 为基线。随附 [源码快照](references/source/) 保留上游相对路径。针对用户的 fork 或业务资产修改时，以目标 checkout、实际运行组件及其 ABI 为准，并说明与官方基线的差异。

- 查官方文档时，按 [官方文档索引](references/official-docs.md) 选专题，再用目标版本源码核对运行语义。
- 新增模块、组件、独立实体或分析进程关系时，读 [模块、实体与进程选型](references/module-and-entity-design.md)。
- 查进程、实体、RPC、AOI 或数据落库时，先读 [源码导航](references/source-map.md)，沿相关入口定位到具体函数。
- 查钩子的宿主、签名和先后条件时，读 [生命周期钩子](references/lifecycle-hooks.md)，在目标版本运行派发点检索并追查调用分支。
- 查 `cellData`、实体回收、传送、登录、Flags 或落库语义时，读 [引擎机制与常见误判](references/engine-knowledge.md)。
- 查 Python 导入、扩展、绑定、热重载或解释器崩溃时，读 [Python 3.7.3 运行手册](references/python373.md)。
- 查来源、快照范围和校验方法时，读 [版本与源码来源](references/provenance.md)。

## 工作方法

1. 固定目标 commit、组件名和业务资产目录。游戏脚本行为结合项目的 `entities.xml`、实体 `.def` 和脚本逐层核对。协议和配置以同版本定义、调用点及生成产物为证据。
2. 跨进程问题从发起方沿 `*_interface.h` 的消息定义追到接收处理器，核对反向回包、线程或事件循环、回调完成及断线回收。用同一组日志字段关联组件 ID、实体 ID、账号/数据库 ID、space ID 与实际发生顺序。
3. 先确定状态归属，再设计变更。属性问题核对定义中的可见性和持久化标记，迁移问题核对源与目标 Cell，DB 问题核对异步结果何时回到 Base。滚动升级前比较两端实体定义和协议摘要。
4. 给出最短源码链和可证伪的现象。区分源码推断、独立脚本测试、嵌入式运行验证。需要验证运行时或回调顺序时，使用同版引擎与匹配资产的隔离环境。涉及登录、实体重载、持久化或跨进程迁移时，覆盖正常路径及一个相关故障路径。
