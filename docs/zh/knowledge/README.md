# 知识库 (KB-001)

> KB-001 [P2]:双语(en + zh)引擎知识库,以 `kbe/src` 下的 KBEngine 源码为据
> (`kbengine@c2a3b8f`)。每条结论标注确切 `文件:行号`;不虚构行为,不把未实现
> 写成已实现。

## 结构

| 桶 | 内容 | 状态 |
| --- | --- | --- |
| ① API 知识 | `KBEngine.*` Python API 参考 | 待办(后续批次) |
| ② 引擎机制文档 | 生命周期、引用、回调、定时器、网络 | **进行中** |
| ③ 使用模式与统计 | 典型用法、频率统计 | 待办(后续批次) |
| ④ 踩坑经验 | 陷阱、坑、常见 bug | 待办(后续批次) |

语言约定(与文档站 locale 镜像一致,同 `guide/` ↔ `zh/guide/`):`en/` 树在
`docs/knowledge/<topic>.md`,`zh/` 双胞胎在 `docs/zh/knowledge/<topic>.md`,
同一引用、同一结论。`en/` 文件是行号漂移校验的规范件。

## 文章

- **实体对象生命周期与引用释放** — 用户点名的头号专题(内存对象引用与释放):
  - [English](../../knowledge/entity-lifecycle-reference.md)
  - [中文](entity-lifecycle-reference.md)
  - 覆盖:活跃注册表强引用(`entities.h:24`);移出注册表进 `garbages` 的销毁
    流程(`entity_macro.h:1486`,`entity_app.h:713`,`entities.h:331`);非持有
    `garbages` 注册表(`entity_garbages.h:23`);销毁后的引用语义;3600 秒泄漏
    检测(`entity_garbages.h:289`);销毁护栏 / AssertionError 踩坑
    (`cellapp/entity.cpp:315/:322`);`onDestroy` callScript 语义与 cell 数据
    备份(`cellapp/entity.cpp:204`);定时器注册/移除(`entity_macro.h:1478`)。

- **API 参考:client 面** (KB-API-002):
  - [English](../../knowledge/api-client.md)
  - [中文](api-client.md)
- **API 参考:baseapp 模块 + Entity/Proxy** (KB-API-003):
  - [English](../../knowledge/api-baseapp.md)
  - [中文](api-baseapp.md)
- **API 参考:baseapp Entity 类** (KB-API-003):
  - [English](../../knowledge/api-baseapp-entity.md)
  - [中文](api-baseapp-entity.md)
- **API 参考:cellapp 面** (KB-API-004):
  - [English](../../knowledge/api-cellapp.md)
  - [中文](api-cellapp.md)

- **API 参考:interfaces 面** ((KB-API-005)):
  - [English](../../knowledge/api-interfaces.md)
  - [中文](api-interfaces.md)

- **API 参考:loginapp/dbmgr/logger 进程全局面** ((KB-API-006)):
  - [English](../../knowledge/api-loginapp-dbmgr-logger.md)
  - [中文](api-loginapp-dbmgr-logger.md)

- **API 核心概念地图** ((KB-API-008)):
  - [English](../../knowledge/api-core-concepts.md)
  - [中文](api-core-concepts.md)
- **API 参考:bots 面** (KB-API-007):
  - [English](../../knowledge/api-bots.md)
  - [中文](api-bots.md)
  - 覆盖:bots 进程脚本面组装(六个注册点);`KBEngine` 模块 19 个函数
    (8 个已记载 + 11 个 fork 独有),含 `addBots`「请求 vs 即时创建」语义;
    入口脚本回调 `onInit`/`onFinish`(外加 fork 独有的 `onTargetChanged`);
    只读的 `bots`(`PyBots`)映射;客户端对象面(源料名 "PyClientApp" =
    fork `ClientObjectBase`);共享 `Entity` 面的本地重锚定;3.7-vs-fork 偏差表
    (含源料虚构的 `cellData`/`isOnGround`/`PyClientApp` 条目)。

## 流水线

源码提取 → 人工精校 → 消费方。计划中的消费方(后续批次,不虚构为已完成):

- **C-21**:KB 文章驱动的 hover 提示。
- **MCP-001**:将 KB 暴露给 MCP 供 agent 消费。
- `kbe-api-scan.py` 提取脚本(桶 ①)属**后续批次**交付物——尚未编写。

## 依据规则

- 引用必须解析到 `kbe/src` 的真实行;写作前对照工作区提交核验。
- 后续批次主题(定时器/Functor 深层引用持有、baseapp 路径细节、跨进程引用
  流)标注 **TODO**,绝不写成已完成。
- KB-001 在 `todo.md` 中保持**未勾选**,直至所有桶与消费方交付。
