# Kode 提案：Rust Core 常驻语言服务（rust-analyzer 式架构）

<!--
来源: 外部评审（ChatGPT 分享链 https://chatgpt.com/s/t_6adaae4f64948191b2647cd05b2cabfb）
整理日期: 2026-10-23
性质: 外部建议。原文自述「未取得仓库完整源码」——其对现状的判断为公开信息推测；
对本提案的任何采纳必须先对照今晚 PR1-7 的实测数据再定边界。
-->

## 对照表（提案 vs 2026-10-23 晚间 PR1-7 实况）

| 提案章节 | 状态 | 证据 |
|---|---|---|
| 第一阶段 性能基线 | ✅ 已完成（提案要求的指标大半已建） | PR1 89e8783: languageServiceMetrics 11 类事件/基线报告 docs/perf/2026-baseline.md |
| 避免多处重复扫描解析 | ✅ TS 侧已统一 | PR3 2aca694 indexScheduler；PR4 4bfba9b semanticIndex+dependencyGraph |
| types.xml 变更只更新受影响节点 | ✅ 已实现 | PR4: 依赖图 scoped invalidation，fullRebuild 恒 false |
| 缺少常驻索引→跳转慢 | ✅ 大幅缓解 | PR5 d4fd634: 冷启动 Definition 首查 107,737ms→468.69ms（≈230×） |
| 诊断重复计算 | ✅ 已收敛 | PR6 ae4256d: 诊断重算 19→7，无关事件 0 |
| Rust Core / 常驻 LSP / 五阶段迁移 | ⬜ 未开始（新弧线） | 本提案独有价值；是否立项=以 PR7 复测数据为依据的下一步决策 |
| 终端/脚本启动慢 | ⬜ 独立问题（提案也强调分开处理） | 与语言服务无关，另行立项 |

结论：提案的「第一阶段」与「反重复扫描」诉求已被 TS 侧 PR1-7 大体兑现；
剩余决策点是 **Rust Core 是否值得作为下一弧线**——用 PR7 复测数据 +
一个最小 Rust 原型（.def/types.xml 解析器+索引对拍）再定，不盲迁。

---

] 很成熟。

但两种方案解决的问题不同：

| 方案 | 优点 | 局限 |
|--------|--------|--------|
| NAPI-RS | 调用开销较低，适合高频同步计算 | 可能阻塞扩展宿主线程，需要专门处理异步任务 |
| Rust 常驻 LSP | 隔离计算负载，支持增量索引及标准编辑器能力 | 需要管理进程及通信协议 |
| Rust CLI | 适合单次批处理任务 | 反复启动与重建索引的成本高 |

**Kode 我更推荐常驻 LSP；对于大量数据转换，可以在 Rust 服务内部实现批处理接口。**

特别是你之前已经反馈过：运行 Python 脚本每次新建 Terminal 太慢。

这与语言服务核心的性能问题要分开处理。Rust LSP 并不会自动解决终端启动慢的问题。脚本执行需要另外设计可复用的执行会话、进程管理或终端池，避免每次请求都重新初始化执行环境。

## 四、先排查慢的真正原因

你说“速度实在太慢了”，我认为这里必须区分四种延迟：

| 现象 | 优先调查方向 |
|--------|--------|
| 打开 VS Code 项目很慢 | 扩展激活、初始化和全量文件扫描 |
| 输入 `.def` 出现明显卡顿 | 解析器、补全、诊断重复计算 |
| 跳转定义、查找引用很慢 | 缺少项目级常驻索引 |
| 运行脚本、启动命令很慢 | Terminal / Python 进程生命周期 |

仓库的 `package.json` 包含 `onLanguage:python`、`workspaceContains:**/*.def` 等激活条件，也有大量命令和功能模块。这值得做一次激活路径和初始化任务的性能审查，但单凭这些配置不能证明瓶颈所在。citeturn941535view1

我建议先增加统一性能指标：

- `extensionActivationMs`：激活耗时
- `workspaceIndexMs`：首次项目索引耗时
- `incrementalUpdateMs`：单文件变更后的更新时间
- `completionP95Ms`：补全响应 P95
- `definitionP95Ms`：跳转定义响应 P95
- `scriptStartMs`：执行命令到脚本启动的时间
- `extensionHostCpu`：扩展宿主 CPU 消耗

然后选一个真实 KBEngine 大型项目做迁移前后的对照测试。

## 五、建议实施顺序

**第一阶段：性能基线**

记录当前冷启动、热启动、索引、补全、导航及命令执行的实际耗时。明确是 CPU 密集、磁盘 I/O、重复计算还是进程启动开销。

**第二阶段：Rust 统一索引**

优先迁移 `.def`、`types.xml`、`entities.xml` 的解析与实体关系索引，并做增量更新。不急着迁移 UI 和全部功能。

**第三阶段：Rust LSP**

让补全、诊断、定义跳转、引用查询共用一份索引。保留原有 TypeScript 实现作为测试对照，确认结果一致后再替换。

**第四阶段：Python 类型与关联分析**

实现统一类型图、`.pyi` 生成、Python 与 KBEngine 定义互相跳转。确保生成文件可通过 source mapping 找到原始来源。

**第五阶段：跨平台交付**

为 Windows、Linux、macOS 的 x64 / ARM64 构建 Rust 原生二进制，处理 VSIX 打包、远程工作区和版本匹配。

## 六、一个必须注意的问题

Rust 不能保证自动提速。比如当前解析一个文件只用 2ms，但因为重复初始化、扫描和调用，用户要等 3 秒，那么仅把那 2ms 改成 0.2ms，体验几乎不会变化。

真正值得追求的是：

**一次扫描 → 一次解析 → 建立索引 → 多功能共享 → 文件变化时局部更新。**

我没有成功取得仓库完整源码，因此目前只能基于公开的仓库结构、配置及功能说明作架构判断，不能把上面的疑似瓶颈当作已经证实的代码问题。

**最终结论：我支持 Kode 将核心迁移到 Rust，并且推荐采用 rust-analyzer 式的长驻语言服务架构。** 如果你准备大幅重构，可以把这一轮视为建立 Kode Core 的机会，而不只是一次语言迁移。下一步最有价值的是对 `src/extension.ts` 的初始化链、各 Provider、文件解析和缓存机制逐项审计，再确定 Rust Core 的模块划分与迁移边界。

]**

Rust 实现解析和检查核心，提供 LSP 服务供编辑器调用。适合参考原生程序与 VS Code 扩展的进程分离、部署和通信方式。

https://github.com/oxc-project/oxc · https://github.com/oxc-project/oxc-vscode

这些都是实际采用 Rust 原生核心的编辑器工具，并非理论方案。turn915266search2

## 二、针对 Kode，哪些部分应该改成 Rust？

我查看了仓库公开的功能清单、`package.json` 和 `todo.md`。Kode 已经不是简单的 `.def` 语法高亮插件，而是包含实体分析、Python 支持、数据库结构分析、依赖关系、代码生成、服务器管理等多种能力的开发环境。turn941535view1

按这些功能的特征，我会这样安排迁移优先级：

| Kode 功能 | Rust 迁移建议 | 优先级 |
|--------|--------|--------|
| `.def`、`types.xml` 解析 | Rust 统一解析器 | P0 |
| 实体继承、接口与类型关联 | Rust 内存索引及增量计算 | P0 |
| 定义、引用、跨文件跳转 | Rust LSP | P0 |
| Python 文件分析及 typings | Rust 分析调度与生成核心 | P1 |
| 依赖关系图计算 | Rust 图索引 | P1 |
| 项目扫描、文件监听处理 | Rust 增量索引 | P1 |
| 大型日志过滤与搜索 | Rust 流式处理 | P2 |
| 配置界面、Webview | 保留 TypeScript | 不迁移 |
| VS Code 命令及 UI | 保留 TypeScript | 不迁移 |
| 服务器启动、终端交互 | 优先优化现有实现 | 暂不迁移 |

这里最重要的不是 Rust 解析 XML 比 JavaScript 快多少，而是**避免多个功能重复扫描、解析和构建同一份项目数据**。

例如 `types.xml` 被修改后，不应该把全部 `.def`、Python 文件及依赖关系重新计算一遍。应该只更新受影响的类型及依赖节点。

这也是为什么我认为 Rust 常驻语言服务器比单纯开发一个 Rust XML 解析模块更有长期价值。

## 三、我推荐的最终架构

**VS Code Extension — TypeScript**

命令 · TreeView · Webview · 配置 · 调试 · 终端

LSP / JSON-RPC（长驻连接）

**Kode Core — Rust**

文件索引与缓存

XML / DEF 解析

统一类型系统

Python 语义关联

引用与依赖分析

Diagnostics / LSP

**KBEngine Workspace**

types.xml · entities.xml · \*.def · \*.py · 引擎定义

我的具体设计建议：

- 使用 `tower-lsp-server` 或 `lsp-server` 构建常驻 Rust 服务。
- 使用 `quick-xml` 解析 XML，但同时保存源文件位置、标签位置和属性位置，避免丢失导航信息。
- 使用 `ropey` 管理频繁编辑的文本。
- 使用 `rowan` 或自定义带位置的语法树，根据 `.def` 的实际语法特点选型。
- 使用 `Salsa` 思路组织增量计算；是否直接采用 Salsa 库应通过原型验证。
- Python 语义分析优先评估复用现有分析器，而不是从零实现 Python 类型检查器。

### 为什么不直接使用 NAPI-RS？

可以使用，而且 entity[\\

]}/>

| Kode 功能 | Rust 迁移建议 | 优先级 |
|---|---|---|
| `.def`、`types.xml` 解析 | Rust 统一解析器 | P0 |
| 实体继承、接口与类型关联 | Rust 内存索引及增量计算 | P0 |
| 定义、引用、跨文件跳转 | Rust LSP | P0 |
| Python 文件分析及 typings | Rust 分析调度与生成核心 | P1 |
| 依赖关系图计算 | Rust 图索引 | P1 |
| 项目扫描、文件监听处理 | Rust 增量索引 | P1 |
| 大型日志过滤与搜索 | Rust 流式处理 | P2 |
| 配置界面、Webview | 保留 TypeScript | 不迁移 |
| VS Code 命令及 UI | 保留 TypeScript | 不迁移 |
| 服务器启动、终端交互 | 优先优化现有实现 | 暂不迁移 |

>types.xml · entities.xml · *.def · *.py · 引擎定义

**可以，而且我认为 Kode 很适合采用 Rust + TypeScript 混合架构。**

但我不建议简单地把 TypeScript 全部改成 Rust。对于你的 [Kode 项目](https://github.com/cuihairu/kode)，更值得做的是：**保留 VS Code 扩展层，用 Rust 实现常驻的代码分析、索引、类型系统和语言服务核心。**

这不仅是为了提升速度，也能为你之前提出的 `types.xml` 类型推导、Python typings 生成、跨文件引用和跳转到原始定义等需求打好基础。

## 一、已经有成熟的成功案例

但我不建议简单地把 TypeScript 全部改成 Rust。对于你的 https://github.com/cuihairu/kode，更值得做的是：**保留 VS Code 扩展层，用 Rust 实现常驻的代码分析、索引、类型系统和语言服务核心。**

image_group{\\

## 落地跟踪（下一弧线，PR7 收官后评估，勾一项补 commit）

- [x] R1 Rust Core 前置审计: 用 PR1-7 指标定位 TS 残余成本 top3（冷启动 468ms 构成拆解/补全 P95/内存），产出「迁移值得/不值得」数据结论（完成见 docs/review/2026-10-27-r1-migration-data-audit.md:P0 后复测 S1 冷扫 107.7s→4.88s(22×,TS 修法拿满);残余 top3=内存峰值(9.3×–33.8×,真数量级)/def 大文件超线性(6.7×–11.9×,MEGA 14.6×)/增量指纹(BigInt FNV,TS 换实现即可修,非迁移理由);分面结论=P0-1a 维护面不值得(两面同 O(自身类),只剩常数)、P0-3c def/types.xml 面值得(内存数量级+解析近一阶,即 R2 范围);R2 放行,R3 继续双闸）
- [x] R2 最小原型对拍: Rust .def+types.xml 解析器（quick-xml 带位置）+实体索引，与 TS 实现同语料 diff 结果一致（phase2-slice-a 已交付,2026-10-27 核验补勾:kode-parser 逐字节 span 状态机(quick-xml 未用,仓库零第三方依赖铁律,span 粒度到字节强于提案设想)+kode-index 实体索引(继承链/反查/generation);五张 parity golden 双侧同语料复算含 line 位置比对(TS 侧 tests/kodeIndexParity.test.ts:278,门禁绿);增量零重建金丝雀 cargo tests/incremental.rs+index_units.rs 全绿(1 rebuild/99 hit,二扫 rebuilds==0 不 bump generation);证据 be4d3d8/f8b37b7/8cd4b4b）
- [ ] R3 （仅当 R1/R2 过闸）tower-lsp-server 骨架: definition/hover 两能力走 LSP，TS 侧保留对照
  - **状态拆分记录（2026-10-29，IDE-RST-002；「骨架已存在」≠「迁移完成/已切流」，据 2026-10-27 范围评审修正建议 5）：**
    - **骨架已存在**：`crates/kode-server`（PR-003）——自研 **stdio** 泵（reader 线程 + `kode-protocol` 帧编解码 + 取消穿越 + 崩溃重启语义），**非 tower-lsp**（仓库零第三方依赖铁律，提案原文 tower-lsp-server 设想未采纳）；server 侧四条能力响应链齐备：definition / hover / completion / diagnostics（`crates/kode-server/src/{definition,hover,completion,diagnostics}.rs`，各配 golden dump bin）。语料/索引侧 kode-parser/kode-index 等 8 crate 已落地（`crates/README.md`）。
    - **shadow 已接面（kode2 phase2-slice-a）**：definition + diagnostics 两面经 `gate.compare()` 影子对拍（`src/kodeCoreShadowFaces.ts`，入口 `shadowCompareDefinition`/`shadowObserveDefDocument`，挂 languageProviders 定义/诊断路径）；shadow 会话内 .def+types/entities/alias.xml 语料镜像同步腿在位。**hover 与 completion 的 shadow 接线未接**（server 侧响应链与 golden 已有，TS 侧 compare 面未挂）——shadow 覆盖记录与 `kodeCoreShadowFaces.ts` 实际 compare 面由 tests/rstServingStatusDoc.test.ts 逐项锁死，新增面必须同笔改本记录。
    - **未开放能力（serving 门禁现状）**：`kbengine.core.backend=rust` 字面量被 serving 门禁拒绝（`src/kodeCoreGate.ts` `serveFromRust()` **恒 false**，本文件落地跟踪期内唯一放行点）；Rust 路径一律不服务，TS 仍是全部 LSP 能力的服务实现；默认 `ts` 模式零可见变化。
    - **正式切流门（切流前置条件清单）**：`docs/kode2/pr-012.md` §4 七项（门 1 基准全绿/门 2 golden 扩面全绿/shadow 实战一周 diff 归零/回退演练/kill-switch 复验/版本门/评审签字），任一未勾即维持 serving 拒绝；三门现状=门1 🟡 门2 🟡 门3 🟡（pr-012 §3）。R3 勾选条件以该清单为准，不以骨架存在为准。
- [ ] R4 终端/脚本执行会话池（独立问题，与 Rust 无关，另单）

