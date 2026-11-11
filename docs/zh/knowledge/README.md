# 知识库 (KB-001)

> KB-001 [P2]:双语(en + zh)引擎知识库,以 `kbe/src` 下的 KBEngine 源码为据
> (`kbengine@c2a3b8f`)。每条结论标注确切 `文件:行号`;不虚构行为,不把未实现
> 写成已实现。

## 结构

| 桶 | 内容 | 状态 |
| --- | --- | --- |
| ① API 知识 | `KBEngine.*` Python API 参考 | **完成**(KB-API-001~009 全部落地;C-21 消费:225 条抽取库喂 hover/RPC) |
| ② 引擎机制文档 | 生命周期、引用、回调、定时器、网络 | **首批完成**(lifecycle + 迁移/传送 + 启动流程 + 入口 SPI + 目录路径;baseapp 路径细节仍为后续批次 TODO) |
| ③ 使用模式与统计 | 典型用法、频率统计 | **首批完成**(`kbe-api-scan.py` + api-usage-stats,仅本仓库两树口径;官方示例/真实项目扩大属后续) |
| ④ 踩坑经验 | 陷阱、坑、常见 bug | **索引建立**(traps-index 汇总各页陷阱;随页面增长持续对账) |

语言约定(与文档站 locale 镜像一致,同 `guide/` ↔ `zh/guide/`):`en/` 树在
`docs/knowledge/<topic>.md`,`zh/` 双胞胎在 `docs/zh/knowledge/<topic>.md`,
同一引用、同一结论。`en/` 文件是行号漂移校验的规范件。

站点组织(2026-11-11;`docs/.vitepress/config.mts`):知识库侧栏分四组——
**引擎基础 / 实体机制 / API 参考 / 语义陷阱**。cellapp API 页拆为两面——
`api-cellapp.md`(`KBEngine` 模块面 + 双面通用的组装层地图)与
`api-cellapp-entity.md`(cellapp 上注册的共享 `Entity` 类)——与既有
baseapp 两篇同构。`knowledge/official-docs/`(kbengine.github.io 原始 HTML
抓取,每页自带来源链接)是提取工作料:留仓作取证底料,经 `srcExclude`
不入站。

## 文章

- **`.def` 属性 Flags——引擎完整真值**(2026-11-09,源自「Flags 解析错误 /
  CELL_PUBLIC_AND_OWN」用户报障):
  - 覆盖:9 个位值(含 `ED_FLAG_UNKOWN`,`common.h:19-27`);8 个关系掩码及
    运行时消费位点(`common.h:40-56`,`cellapp/entity.cpp:689/:724/:800/:854/:
    883`,`entity_macro.h:629`);引擎接受的 12 个拼写——8 规范名 + 4 旧式别名
    落同位(`g_entityFlagMapping`,`entitydef.cpp:161-174`);两条解析路径的
    严格度分歧(XML `entitydef.cpp:1136-1173` 转大写、认别名、硬失败 vs 装饰器
    `py_entitydef.cpp:2507` → `common.cpp:42-68` 严格 8 名链,别名静默变
    `ED_FLAG_UNKOWN`);映射表暴露为 Python 模块常量(`py_entitydef.cpp:
    2912-2926`);逐旗标运行时语义表;踩坑索引;kode 单一来源镜像管线
    (`model.rs` → golden → `src/generated/flagDomains.ts`)。

- **实体对象生命周期与引用释放** — 用户点名的头号专题(内存对象引用与释放):
  - 覆盖:活跃注册表强引用(`entities.h:24`);移出注册表进 `garbages` 的销毁
    流程(`entity_macro.h:1486`,`entity_app.h:713`,`entities.h:331`);非持有
    `garbages` 注册表(`entity_garbages.h:23`);销毁后的引用语义;3600 秒泄漏
    检测(`entity_garbages.h:289`);销毁护栏 / AssertionError 踩坑
    (`cellapp/entity.cpp:315/:322`);`onDestroy` callScript 语义与 cell 数据
    备份(`cellapp/entity.cpp:204`);定时器注册/移除(`entity_macro.h:1478`);
    引擎持有的未决回调——「Functor」之问落定为 `PY_CALLBACKMGR` 强引用 +
    超时回收 + 迁移 pickle(`callbackmgr.h:215`)。

- **实体传送、跨 cellapp 迁移与跨进程引用**:
  - 覆盖:一个实体三个可寻址面与 `EntityCall` 的 `(进程, id)` 远程句柄语义
    (`entity_call.h:15`,`common.h:285-291`);`cellData` 设计即旧快照
    (`baseapp/entity.cpp:250/:1024/:1112`);`teleport` 路由与守卫
    (`cellapp/entity.cpp:3394/:3713`);跨 cellapp 完整消息流——ghost 化
    (`:3964`)、baseapp 消息暂存与 `cellEntityCall_` 原地重定向
    (`baseapp/entity.cpp:1571/:1622/:1635`)、目标端重建
    (`cellapp/cellapp.cpp:1880`)、成功销毁与失败恢复(`:2075/:2143`);
    HEAD 上实际触发的传送回调(base 面是死路径,
    `baseapp/entity.cpp:1543-1546`);引用失效规则与踩坑清单。锚定
    `kbengine@3082ab5`。

- **API 参考:client 面** (KB-API-002):
- **API 参考:baseapp 模块 + Entity/Proxy** (KB-API-003):
- **API 参考:baseapp Entity 类** (KB-API-003):
- **API 参考:cellapp 面** (KB-API-004;拆为模块面 `api-cellapp.md` 与
  Entity 面 `api-cellapp-entity.md` 两篇):

- **API 参考:interfaces 面** ((KB-API-005)):

- **API 参考:loginapp/dbmgr/logger 进程全局面** ((KB-API-006)):

- **API 核心概念地图** ((KB-API-008)):
- **API 参考:bots 面** (KB-API-007):
  - 覆盖:bots 进程脚本面组装(六个注册点);`KBEngine` 模块 19 个函数
    (8 个已记载 + 11 个 fork 独有),含 `addBots`「请求 vs 即时创建」语义;
    入口脚本回调 `onInit`/`onFinish`(外加 fork 独有的 `onTargetChanged`);
    只读的 `bots`(`PyBots`)映射;客户端对象面(源料名 "PyClientApp" =
    fork `ClientObjectBase`);共享 `Entity` 面的本地重锚定;3.7-vs-fork 偏差表
    (含源料虚构的 `cellData`/`isOnGround`/`PyClientApp` 条目)。

## 流水线

源码提取 → 人工精校 → 消费方。消费方现状:

- **C-21**:KB 文章驱动的 hover 提示(已交付,见 `src/pythonApiHoverDocs.ts`
  与 `crates/kode-server/api_docs.rs`)。
- **MCP-001**:将 KB 暴露给 MCP 供 agent 消费(已交付,`crates/kode-mcp/
  src/explain.rs` 的 `explain` 工具:API 面=C-21 共享库,机制面=上文文章索引)。
- **API 使用模式与频率统计**(桶 ③):
  - 覆盖:`scripts/kbe-api-scan.py`(AST 解析,仅标准库)扫本仓库两树
    (77 文件,0 解析错误);`KBEngine.*` 模块使用表;实体 API 成员热度;
    引擎已知 vs 项目自定义回调划分(约 1/3 项目自定义);观察到的模式
    (定时器纪律——`delTimer` 从未被调用、cell 创建对、远程句柄方向、
    interfaces 轮询对)。口径如实:仅本仓库两树。
- **语义陷阱索引**(桶 ④):
  - 覆盖:全知识页单行陷阱索引——内存与引用、迁移/传送、定时器与控制器、
    EntityCall 语义、回调命名与面放置、client 面可用性、源材料卫生。每行
    链到承载完整 grounding 根因的文章;不引入目标文章之外的论断。

## 依据规则

- 引用必须解析到 `kbe/src` 的真实行;写作前对照工作区提交核验。
- 后续批次主题(baseapp 路径细节)标注 **TODO**,绝不写成已完成。跨进程
  引用流(迁移/传送)与定时器/未决回调的引用持有(「Functor」之问——
  KBEngine 无 Functor,持有者是 `PY_CALLBACKMGR`)已有专文覆盖
  (锚定 `kbengine@3082ab5`)。
- KB-001 在 `todo.md` 中已**勾选**(2026-11-07,`65f94116` + `20643807`),
  交付边界记录在案:「官方 API 清单 >=95%」无仓库内结构化官方清单可对账
  (与 C-21 勾选同一边界——覆盖口径为已 grounding 的 225 条 API 面);桶 ③
  统计仅覆盖本仓库两树;桶 ② 的 baseapp 路径细节仍为记录在案的 TODO。
