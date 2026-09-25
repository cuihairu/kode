# Kode 重设计：不依赖真实 KBEngine 环境的测试基座

> 状态：已立项，分阶段落地中。基线测量时间：2026-09-25。
> 配套现状问题清单见本文第 1 节；每阶段完成情况见第 6 节的进度表。

## 0. 背景与动机

Kode 是 KBEngine 的 VSCode 开发插件。功能验证长期面临一个结构性矛盾：

- 插件的**语言层**（.def 解析、补全、悬停、诊断、跳转）只需要文件，已经可以在纯逻辑层测；
- 但插件的**运行时层**（服务器启停、日志收集、监控采集、调试附加）天然面向一个
  分布式 KBEngine 集群：machine 组件 UDP 广播发现（端口 20086）、每个组件的
  watcher TCP 端口（msgid 41001-41008）、logger TCP 端口（20022）、真实引擎二进制
  （`kbe/bin/server`）、真实进程 PID 与 telnet 调试端口（31000-51000）。

目前要端到端验证运行时层，要么有一套真实 KBEngine 检出和运行环境，要么靠测试里
零散手写的回环 socket/假进程拼凑。结果是：难测、慢测、测不全、CI 上跑不了。

本重设计的核心命题：**把"运行时依赖"从"环境里碰巧有什么"变成"测试显式提供什么"**，
做到没有真实 KBEngine 环境也能全链路验证，同时保持对真实环境的兼容不变。

## 1. 现状问题清单（摸底结论）

以下每条都有代码证据，按"难在哪"归类。

### 1.1 必须依赖真实 KBEngine 环境

| # | 问题 | 证据 |
|---|------|------|
| P1 | 服务器管理直接 spawn 引擎二进制，探测路径写死 `../kbengine/kbe/bin/server` 与 `KBENGINE_HOME` | `src/serverManager.ts:192-195`、`spawn` 调用 `src/serverManager.ts:329` |
| P2 | machine 发现的 UDP 广播端口 20086 硬编码、不可注入 | `src/kbengineProtocol.ts:45`、`socket.send(frame, MACHINE_BROADCAST_PORT, '127.0.0.1')` `src/kbengineProtocol.ts:430` |
| P3 | 监控采集依赖真实 machine 应答 + 每组件真实 watcher TCP 服务 | `src/monitoringCollector.ts:187,338`（`discoverLocalComponents`/`queryWatcherPath`） |
| P4 | 日志收集直连 logger TCP 20022，且协议适配未完成，`connect()` 按现状直接拒绝 | `src/extension.ts:343`、`src/logCollector.ts`（connect 拒绝路径已有测试锁定） |
| P5 | 调试附加需要真实组件进程 PID、telnet 端口 31000-51000 与 debugpy | `src/debugConfig.ts:30,271` |
| P6 | 引擎源码逐行校验测试依赖同级 `../kbengine` 检出或 `KBENGINE_ROOT`，缺失即 skip，CI 无引擎时不执行 | `tests/helpers/engineRoot.ts` |

### 1.2 启动与联调慢、调试链路长

| # | 问题 | 证据 |
|---|------|------|
| P7 | **从未有过真实 VSCode 验证**：`@vscode/test-electron` 声明为 devDependency 但 `runTest.ts` 从不调用它；mocha 层实际在纯 Node 里以 `module._load` 补丁注入假 vscode 运行。所谓"集成层"与 vitest 层同构，只是又造了一套 fake | `src/test/runTest.ts`（无 runTests 调用）、`src/test/suite/testUtils.ts` `loadModuleWithMocks` |
| P8 | 全量门槛实测 47s（lint + vitest 701 用例 36s + clean/tsc 全量重编译 + mocha 110 用例）；时长尚可，真正的成本在**双 runner 双 fake 的重复维护**与失败后整轮重跑（无按需分层入口） | `package.json` `test` 脚本；2026-09-25 实测 |
| P9 | 回环 socket 测试绑定固定端口 20086，迫使 vitest 全局 `fileParallelism: false`，56 个文件串行，拖慢整层 | `vitest.config.ts` 注释与配置、`tests/kbengineProtocolSocket.test.ts` |
| P10 | 真实进程编排测试对信号时序敏感：SIGKILL 升级用例必须等 bash trap 标记，高负载下偶发翻车（TESTING.md 自述） | `tests/serverManagerProcesses.test.ts`、`TESTING.md` 批24 记录 |

### 1.3 缺少统一的 mock / 本地仿真

| # | 问题 | 证据 |
|---|------|------|
| P11 | 没有"假 KBEngine 集群"这类基建：machine 应答器、watcher TCP 服务、logger 服务、假组件二进制，全部散落在各个测试文件里各自手写一份 | `tests/kbengineProtocolSocket.test.ts`、`tests/monitoringCollectorSocket.test.ts`、`tests/serverManagerProcesses.test.ts` 各自内联 |
| P12 | vscode 替身有两套且已分叉：vitest 层 `tests/helpers/vscodeStub.ts`（416 行）与 mocha 层 `src/test/suite/testUtils.ts` 的 Fake* 类；语义不一致（如 `FakeLocation` 持 `position`，而真实与 stub 的 `Location` 持 `range`）。且 P7 表明 mocha 层并不更"真实"，分叉纯属重复建设 | 两文件对比 |
| P13 | stub 是"最小满足求值"型，不可编程：workspace 状态、文档集合、配置变更、窗口消息、面板消息都要每个测试自己 monkey-patch，重复且脆弱 | `tests/helpers/vscodeStub.ts` 顶部注释与各测试文件的 patch 块 |
| P14 | `extension.ts`（532 行装配全部功能）在 vitest 覆盖率里被显式排除，装配逻辑（命令注册、状态栏联动、disposes 链）只有 mocha 层间接覆盖 | `vitest.config.ts` `exclude: ['src/test/**','src/extension.ts']` |

### 1.4 用例难复现、结果难解释

| # | 问题 | 证据 |
|---|------|------|
| P15 | 运行时链路故障只能靠"有真环境的人"复现：monitoring 的部分数据、watcher 拒连、广播包异常等分支，在真实环境里凑场景成本极高 | `TESTING.md` 中大量"真实回环零 mock"测试的凑场景成本记录 |
| P16 | 覆盖率口径分裂：vitest 覆盖率只统计 vitest 加载的 23 个文件，mocha 层的覆盖不合并、extension.ts 不在分母，"98.99% lines"的真实含义依赖口径说明 | `TESTING.md` 说明节、`vitest.config.ts` |

## 2. 目标与非目标

### 目标

1. **G1 零环境测试**：在一台只有 Node.js 的机器上（无 KBEngine 检出、无 VSCode 下载、
   甚至无显示环境），`pnpm test:unit` 可验证全部核心功能，包括运行时链路（发现、
   监控、日志、进程编排、装配）。
2. **G2 快反馈**：核心层（含仿真器集成）单轮 <90s；不需要启动真实 VSCode。
3. **G3 单一替身**：vscode 测试替身只有一套实现、可编程、状态化，vitest 与 mocha
   共用；消除 Fake 分叉。
4. **G4 仿真即产品知识**：KBEngine 仿真器把 machine/watcher/logger/组件进程的
   线上协议行为固化为可执行规格（复用 `kbengineProtocol` 的编解码器），协议回归
   一处发现。
5. **G5 真实验证显式化**：现状是"声明了 test-electron 但从未运行"（P7），真实
   VSCode 行为实际零验证。重设计后：提交门槛（`pnpm test`）不依赖任何真实
   VSCode/引擎；另立独立的可选烟测脚本（真实 VSCode + 可选真实引擎），供发版前
   人工触发，不进门槛。引擎源码条件校验保留。
6. **G6 行为不变**：用户可见功能、公共 API、`package.json` 贡献点不变；重构只动
   内部结构与测试。

### 非目标

1. 不重新实现 KBEngine 服务器本身；仿真器只覆盖插件实际消费的协议面。
2. 不引入 Docker/容器化真实集群作为测试依赖（CI 不可达且慢，见备选方案 A）。
3. 不把真实 VSCode 烟测纳入提交门槛（门槛必须在一台只有 Node 的机器上可达成）；
   现状未被调用的 `@vscode/test-electron` 依赖转为显式的可选 `test:smoke` 脚本
   或移除，在阶段 4 决定。不合并两个 runner 的覆盖率数字（口径如实标注）。
4. 不改动语言层已有 701 个 vitest 用例的断言语义（它们继续有效）。

## 3. 新架构

### 3.1 分层与模块划分

现状是"每个管理器类 = 业务逻辑 + vscode API + Node IO"三合一。重设计按依赖方向
拆成四层，依赖只能向下：

```
┌─────────────────────────────────────────────────────────┐
│ L4 装配层  src/extension.ts                              │
│    只做构造与接线：new 各管理器、注册命令/提供者/面板      │
├─────────────────────────────────────────────────────────┤
│ L3 管理器层（现有类保持类名与公共 API）                   │
│    serverManager / logCollector / monitoringCollector /  │
│    debugConfig / 各 WebView / explorer / mapping ...     │
│    变化：vscode 触点收敛到注入的 UiBridge；               │
│          进程/socket/定时器触点收敛到注入的端口适配器      │
├─────────────────────────────────────────────────────────┤
│ L2 端口层（新，src/ports/）依赖倒置接口                   │
│    ProcessRunner    —— spawn 的可注入抽象                 │
│    SocketFactory    —— TCP/UDP 客户端的可注入抽象         │
│    MachineDiscoveryOptions —— 发现地址/端口/超时注入       │
│    （默认实现 = 真实 child_process/net/dgram，生产行为不变）│
├─────────────────────────────────────────────────────────┤
│ L1 纯域层（现状已基本达成）                               │
│    defParser / definitionSemantics / definitionWorkspace │
│    / kbengineMetadata / hooks / logParser / 协议编解码    │
└─────────────────────────────────────────────────────────┘
```

配套两块独立基建（不属于生产代码）：

```
tests/sim/            KBEngine 本地仿真器（见 3.2）
tests/fake-vscode/    可编程 vscode 替身（见 3.3）
```

### 3.2 KBEngine 本地仿真器（`tests/sim/`）

一个进程内、可编程、零外部依赖的"假 KBEngine 集群"，把 P11 里散落的手写应答器
收敛为正式模块：

- **MachineSimulator**：UDP 应答器。收到 msgid=4 (`MACHINE_MSG_QUERY_ALL_INTERFACES`)
  请求帧后，按 `kbengineProtocol` 的 29 字段线序回放配置好的组件广播包（组件类型、
  PID、地址、intaddr/intport swap、cpu、componentID bigint）。**端口全部动态分配**
  （bind 端口 0，由 OS 指派），把实际端口回报给测试。
- **WatcherSimulator**：每个组件一个 TCP 服务。实现 msgid 41001-41008 的路径查询，
  可编程返回值帧（含分片发送、type 0 值帧/type 1 目录帧）、拒连、超时、恶意包。
- **LoggerSimulator**：TCP 服务承载 logger 端口行为（当前插件侧协议未完成，仿真器
  为后续协议适配先行提供对端；现阶段用可编程的"接受连接即关闭/固定应答"）。
- **FakeComponentBin**：生成假组件可执行文件（跨平台 node/shell 脚本），行为可编程：
  正常运行并周期输出 stdout/stderr、秒退（指定 exit code）、忽略 SIGTERM 强制走
  SIGKILL 升级、输出启动标记。供 serverManager 的进程编排测试消费，替代目前
  测试内联的 bash 脚本拼装。
- **SimCluster**：门面。一键拉起 N 组件仿真拓扑（machine+watcher+可选 logger），
  测试结束统一销毁；所有资源（端口、临时目录、子进程）登记造册，防泄漏。

协议帧的构造与解析**复用 `src/kbengineProtocol.ts` 的导出函数**——仿真器与插件
共享同一份协议规格，这是 G4 的落点。

### 3.3 可编程 vscode 替身（`tests/fake-vscode/`）

在现有 `vscodeStub` 骨架上升级为状态化、可脚本化的单例环境（不是每测试重新发明）：

- **WorkspaceState**：workspaceFolders、内存文件树（升级现有 memoryFileSystem）、
  文档集合（打开/关闭/变更事件）、配置表（含 `onDidChangeConfiguration` 可触发）、
  `createFileSystemWatcher` 事件可注入。
- **WindowState**：消息队列（show*Message 可被断言与编程应答）、QuickPick/InputBox
  脚本化应答（现有 codeGenerator 测试已局部这样做，收敛为公共件）、TextDocument
  打开记录与可编程 showTextDocument（含拒开）。
- **PanelRegistry**：WebviewPanel 工厂可编程（记录创建参数、捕获
  `onDidReceiveMessage`、可 fire `onDidDispose`），四个 WebView 的消息域测试全部
  消费它（替代目前的 monkey-patch 面板工厂）。
- **CommandRegistry**：`registerCommand`/`executeCommand` 真记账，使
  `extension.ts` 的 `activate()` 可以在 vitest 内整体装配并断言注册表、状态栏与
  dispose 链——补上 P14。
- **兼容策略**：`tests/helpers/vscodeStub.ts` 保留为 re-export 薄壳（现有 701 用例
  的 import 路径不破坏），行为源转移到 fake-vscode。mocha 层的 `testUtils.ts`
  Fake* 类逐步退役，统一 import fake-vscode（消除 P12）。

### 3.4 注入点改造（生产代码，最小侵入）

| 模块 | 现状触点 | 改造 |
|------|----------|------|
| `kbengineProtocol.discoverLocalComponents` | 硬编码 127.0.0.1:20086 | 增加可选 `{host, port, timeoutMs}` 参数，默认值不变（P2） |
| `monitoringCollector` | 直呼 `discoverLocalComponents()` | 构造器接受 `discoveryOptions`（含 machine 端口），透传 |
| `logCollector` | 直连 `net` | 保持（host/port 本就可配置）；仿真器只提供对端 |
| `serverManager` | 直 `import { spawn }` | 抽 `ProcessRunner` 端口，默认实现透传 spawn；测试可注入（记录、故障注入），真实进程集成测试继续走真 spawn + FakeComponentBin |
| `extension.ts` | 532 行直连装配 | 保持结构，仅把可注入点（各管理器构造参数）显式化；activate 本身不改签名 |

原则：**默认实现即生产行为**，所有新参数可选且缺省与今天完全一致——改造对用户
零感知（G6）。

## 4. 验证策略：没有真实 KBEngine 环境的测试分层

```
L1 纯逻辑单测（vitest，现状 701 例继续增长）
   依赖：无。覆盖 def/元数据/钩子/日志解析/协议编解码/生成器纯函数。
L2 仿真器集成（vitest，新 tests/sim/*.test.ts + 迁移现有 socket 测试）
   依赖：Node（回环 socket/真实子进程），无 vscode、无引擎、无固定端口。
   覆盖：machine 发现全链路、watcher 采集、监控聚合、服务器进程编排
   （正常/秒退/EACCES/SIGTERM/SIGKILL 升级/startAuto/stopAll/restart）、
   日志收集状态机与重连。
L3 FakeVscode 全链路（vitest，扩展现有 *Panel/*Gaps 系列）
   依赖：fake-vscode + L2 仿真器。覆盖：四个 WebView 的面板生命周期与消息域、
   诊断联动、entityMapping watcher 联动、extension.ts activate 装配与 dispose 链、
   服务器状态→状态栏/树视图刷新。
L4 真实层（显式化、独立于提交门槛）
   L4a 真实 VSCode 烟测（可选脚本 test:smoke，阶段 4 落地或移除依赖）：扩展激活、
       命令注册存在、一个补全/hover/诊断在真实 VSCode 里工作。不进 pnpm test。
   L4b 引擎源码条件校验（保留现有 skipIf 机制）：有引擎检出的机器上跑数据
       vs 源码逐行校验；无引擎自动 skip，不阻塞门槛。
验收基线（G1）："只有 Node 的机器"上跑 L1+L2+L3（即 pnpm test:unit），
   全绿即认为核心功能已验证；L4 是附加保障而非门槛。
```

分层还顺带解决口径问题（P16）：L1-L3 的覆盖率统一在 vitest 一个口径下计算，
`extension.ts` 纳入分母（activate 被 L3 触达）；L4 不进覆盖率、如实标注。

## 5. 关键取舍与备选方案

| 决策 | 选择 | 备选与否决理由 |
|------|------|----------------|
| 假集群形态 | 进程内 Node 仿真器（UDP/TCP/脚本二进制） | **A. 真实引擎 docker-compose**：官方无维护镜像，构建链长，CI 不可用，启动分钟级——违背 G1/G2。 |
| vscode 替身 | 自研状态化 Fake（升级现有 stub） | **B. 引入 jest/vscode 测试框架或 sinon 全家桶**：现有 stub 已成型且贴着项目真实用例长出来；框架迁移成本高收益低。保持 vitest 原生 `vi` + 自研可编程对象。 |
| 端口策略 | 动态端口（bind 0）+ 注入 | **C. 继续固定 20086 + 串行**：这是 P9 的根源，测试永远快不起来且并发不可复现。 |
| 进程测试形态 | 保留真实 spawn + 可编程假二进制 | **D. 全 mock child_process**：spawn 的信号语义、exit 码、流行为 mock 成本高且失真；假二进制是真进程、零失真，只是把拼装收敛进 FakeComponentBin。 |
| runner 格局 | vitest 承载 L1-L3；mocha 层与 vitest 同构（P7）故逐步并轨；真实 VSCode 验证另立可选 test:smoke | **E. 全部下沉 test-electron**：需要下载与显示环境，门槛不可达成（G1/G2）；**F. 维持现状双 runner**：mocha 层并不更真实（P7），纯粹双份维护成本。 |
| extension.ts 覆盖 | FakeVscode 下直测 activate | **G. 继续排除出分母**：装配逻辑是回归高发区（命令漏注册/漏 dispose），P14 已证实当前口径失真。 |

## 6. 分阶段落地计划

每阶段独立可交付、独立 commit，且完成后全量测试必须绿（见第 8 节门槛）。

### 阶段 1：仿真器基座（`tests/sim/`）+ 动态端口

- 新建 `tests/sim/`：`MachineSimulator`、`WatcherSimulator`、`SimCluster` 骨架。
- `discoverLocalComponents` 增加 `{host, port, timeoutMs}` 可选参数（默认不变）。
- 迁移 `tests/kbengineProtocolSocket.test.ts`、`tests/monitoringCollectorSocket.test.ts`
  到仿真器 + 动态端口；解除 `fileParallelism: false`。
- 验收：vitest 全绿且恢复文件并行；两个 socket 测试文件不再出现 20086 字面量；
  单轮时长不劣于现状 36s。

### 阶段 2：进程仿真（`FakeComponentBin`）+ ProcessRunner 端口

- `tests/sim/fakeComponentBin.ts` 生成可编程假组件二进制。
- `serverManager` 抽 `ProcessRunner` 注入点（默认透传 spawn）。
- 迁移 `tests/serverManagerProcesses.test.ts` 到 FakeComponentBin；SIGKILL 用例
  的 trap 标记等待机制内化为仿真器能力。
- 验收：进程编排用例行为等价（含 SIGKILL 升级），不再内联 bash 拼装。

### 阶段 3：FakeVscode 基建 + extension.ts 入测

- `tests/fake-vscode/`：WorkspaceState/WindowState/PanelRegistry/CommandRegistry。
- `vscodeStub.ts` 改为兼容 re-export；新增 `extension.ts` 的 activate/dispose
  装配测试（L3）。
- 验收：extension.ts 进覆盖率分母且激活链各注册点被断言；现有 701 用例不破坏。

### 阶段 4：WebView/管理器迁移 + mocha 瘦身 + 文档

- 四个 WebView 的面板测试迁到 PanelRegistry；mocha 层裁到烟测集；
  `testUtils.ts` Fake* 退役，mocha 复用 fake-vscode。
- 更新 `TESTING.md`（新分层说明）、`docs/guide/development.md`、`README.md`。
- 验收：`pnpm test:unit`（L1-L3）在无引擎、无 VSCode 下载环境下全绿；
  `pnpm test` 全量绿；文档与新架构一致。

### 进度

| 阶段 | 状态 | 里程碑 commit |
|------|------|---------------|
| 1 | 进行中 | — |
| 2 | 未开始 | — |
| 3 | 未开始 | — |
| 4 | 未开始 | — |

## 7. 风险与对策

- **仿真器漂移**（仿真行为 ≠ 引擎真实行为）：协议帧构造复用 `kbengineProtocol`
  同一编解码器；L4b 引擎源码校验继续锚定真实线序；仿真器的"规格即文档"注释逐条
  标注引擎源码依据（沿用现有批注风格）。
- **注入参数蔓延**：每个新参数必须可选、默认等于现行为；用类型测试锁定默认值
  （如 `MACHINE_BROADCAST_PORT === 20086`）。
- **迁移期双轨成本**：阶段 1-3 期间旧写法不立即删除，最后一阶段统一清理；
  每阶段 commit 独立可回滚。

## 8. 提交与验证门槛（沿用仓库现行硬约束）

- 每次 commit / push 前必须全量测试通过（`pnpm lint` + `pnpm test`）；
  有失败先修复，禁止提交红测试。
- 禁止 git tag；禁止任何发布/发版动作；push 仅推当前分支远端，不 force。
