# 内网开发机环境适配审核（Intranet Dev-Machine Environment Audit）

- 日期：2026-11-06
- 对象：kode（本仓，origin/main @ 3317ac0）适配用户真实 KBEngine 项目的内网 Windows 开发机（`D:\kbengine`，Claude Code 会话暴露的环境事实，均已核实）
- 结论先行：**kode 的 .def/entities.xml 层诊断很强，但工作区「配置层」（debug.json / extraPaths / .gitignore / 文档声明）是 0 覆盖**——本次暴露的 6 项环境事实里 4 项属于配置层，且全部只能靠人肉 review + 线上复现才能发现。杠杆解法是新增「配置契约检查」诊断规则（见 §5，已随本审核落地）。

## 0. 环境事实清单（已核实）

| # | 事实 | 层 |
|---|------|----|
| 1 | 工作区 `python.analysis.extraPaths` 配错：`../../kbe/typings` 应为 `../kbe/typings`（KBEngine 标准布局 assets 与 `kbe/` 同级，一层上跳即可） | 配置层 |
| 2 | `.gitignore` 缺 `.kbengine/`（stubs、debug.json 等托管产物有误提交风险） | 配置层 |
| 3 | `.kbengine/debug.json` 的 `debug.components` 为空，loginapp(31000)/dbmgr(32000)/baseapp(40000)/cellapp(50000) 四组件 telnet 段全被注释 → Start Debugging 无预设目标 | 配置层 |
| 4 | telnet 密码实值 `HxQYjC9+WyeiRNYH`（项目覆盖了引擎默认 `pwd123456`），项目 CLAUDE.md 里写的是 `pwd123456` → 文档与配置冲突 | 配置层 |
| 5 | 引擎常量陷阱：`NETWORK_MESSAGE_LENGTH_SIZE=2`（uint16）、`MessageLength` 上限 65535、≥65535 走 `MessageLength1`（uint32）扩展头、`ENCRYPTION_WASTAGE_SIZE` 拼写就是 `ENCRYPTTION`（少一个 P，按 `ENCRYPTION` grep 会漏）、`PACKET_MAX_SIZE_TCP=1460` | 引擎事实 |
| 6 | 协议表是握手期下发而非静态配置（`loginapp.cpp:1469` / `baseapp.cpp:4891` `onImportClientMessages`） | 引擎事实 |

## 1. 工作区配置契约（Workspace Config Contract）

### 1.1 extraPaths 双层上跳（事实 1）

- **问题**：`../../kbe/typings` 从 assets 根出发上跳两层，落到了 `kbe/` 的上一级之外，Pylance 解析不到 `KBEngine.pyi` / `common.*`，`import KBEngine` 全线报 unknown import。
- **kode 现状**：`src/pythonExtraPaths.ts` 已管理 `python.analysis.extraPaths` 的同步（发现 scripts 根 + `.kbengine/stubs` 注入），但纪律是「只管理自己那一段——用户手填的路径永不被动」。这条纪律正确（不覆盖用户配置），副作用是**写错的用户段永远静默存活**：没有面会校验 extraPaths 条目的相对层语义，也没有面会校验条目指向的目录是否存在（写入时 `exists` 只用于 kode 自己发现的根）。
- **建议**：对 extraPaths 做只读诊断——含 `../..` 双层上跳的条目（对 `kbe/typings` 相对语义错）、指向不存在目录的条目，报 Warning 附修复建议文案；不动配置本体，与既有同步纪律互补。

### 1.2 debug.json components 空 + telnet 段全注释（事实 3）

- **问题**：`debug.components` 为空 + 四组件 telnet 段被注释，Start Debugging 无任何预设目标；每个组件的 telnet 端口、密码都要现场手填，调试面退化成裸 TCP。
- **kode 现状**：`src/debugConfig.ts` `DebugConfigManager` 读 `.kbengine/debug.json`：骨架默认面带全部 7 组件（`SOURCE_DEFAULT_COMPONENTS`，loginapp 31000 / dbmgr 32000 / interfaces 33000 / logger 34000 / baseapp 40000 / cellapp 50000 / bots 51000），用户文件解析失败或缺失时**静默回落默认面**；KR-AUD-41 之后默认面不带密码，`telnetPassword` 缺失由 startDebugging 显式提示（不再编造 `pwd123456`）。但「用户文件存在且合法、只是 components 为空/被注释」这条路径没有任何提示——文件合法就不回落、不告警，等于空配置被当成「用户什么都不想调」。`src/telnetDeriveTargets.ts` 的目标派生依赖 components 有货，空 components → 派生面同样为空。
- **建议**：诊断规则对 components 空/缺、已知组件 telnet 端口缺失或偏离已知默认、telnet 段整段被注释（JSONC 层可检出）报 Warning；修好输入，Start Debugging / telnet 树 / debugpy 下一步全部自动回血。

### 1.3 .gitignore 缺 .kbengine/（事实 2）

- **问题**：`.kbengine/` 是 kode 的托管目录（stubs 导出 `src/pythonStubExport.ts`、debug.json `src/debugConfig.ts`、shadow 语料等）。内网机的 .gitignore 没有它，一次 `git add -A` 就把机器本地产物（含 telnet 密码的 debug.json）提交进仓——密码泄露的直接通道。
- **kode 现状**：`src/inferPipeline.ts` 会向 .gitignore 幂等追加**自己那一段**（且「绝不创建」文件），但没有任何面检查 `.kbengine/` 是否在册；`src/managedDir.ts` / `managedDirExclusions.ts` 管目录内排除，不管 gitignore 层。
- **建议**：诊断规则检查 .gitignore 缺 `.kbengine/` 条目即报；kode 侧长期可考虑 managed-dir 首次创建时主动提示（不代写，保持 inferPipeline 同款「不代用户改 gitignore」纪律之外的只读提醒）。

### 1.4 CLAUDE.md 文档声明与配置实值冲突（事实 4）

- **问题**：项目 CLAUDE.md 声明 telnet 密码 `pwd123456`（引擎默认），实值已被项目覆盖为 `HxQYjC9+WyeiRNYH`。按文档走 telnet 全部认证失败；更糟的是这类冲突会传染给一切照抄文档的自动化（AI 会话、CI 脚本）。
- **kode 现状**：kode 完全不读 CLAUDE.md/README，文档声明与 debug.json 实值之间没有任何对账面。`src/telnetWebView.ts` 展示层已如实区分「未配置」与「配置了」（KR-AUD-41），但范围止于展示。
- **建议**：诊断规则对文档（CLAUDE.md/README）中声明式出现的密码/端口与 debug.json 实值做冲突对账，不一致报 Warning（文档行 + 配置文件两侧都点名）。kode 自身文档已遵守「不内置 pwd123456」纪律（telnetWebView 示例文本仍出现 `pwd123456` 仅作引擎默认值的格式示例，与实值无关）。

## 2. 离线可用性（Offline Usability）

- **问题**：三个图视 webview 从公网 CDN 拉库——`src/entityDependencyWebView.ts:1220` 与 `src/entityFlowWebView.ts:280` 加载 `https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js`，`src/monitoringWebView.ts:17` 加载 `chart.js@3.9.1` CDN 常量；CSP（`script-src`）把源钉死在同一路径。内网无外网 → mermaid/chart.js 永远 404/超时，依赖图、实体流图、监控图表空白。
- **kode 现状**：main 上三处 CDN 引用原样在盘；**KR-AUD 批 C（`feat/kode-kr-c`）已做过这批修复——commit `2491152` "fix(webview): vendor mermaid/chart.js, nonce CSP + strict, escape all dynamic labels (KR-AUD-43/50/53/08)"**，把 mermaid/chart.js 本地 vendor 进包并改 nonce CSP。⚠️ **该分支尚未合入 origin/main**（main 上 `git grep cdn.jsdelivr` 仍命中三个文件），内网可用性修复处于「做了没上主干」状态。
- **建议**：合入 `feat/kode-kr-c`（或摘 cherry-pick `2491152`）后在内网机复验三个 webview 断网渲染；后续回归门禁里加一条「media/vendor 内资源可离线加载」的烟测。

## 3. telnet / 调试集成（Telnet & Debug Integration）

- **问题**：事实 3 + 4 组合起来，内网机的调试链是「无预设目标 × 文档密码错误」双断：Start Debugging 无组件可选，手填端口后密码又对不上。
- **kode 现状**：链路面齐全——`telnetService.ts`/`telnetClient.ts`（含 telnet 协议密码认证）、`telnetDeriveTargets.ts`（从 debug.json components 派生目标）、`debugStatusBoard.ts`/`debugStatusTree.ts`（状态板）、`debugpyPreflight.ts`/`debugpyPortProbe.ts`（Python 侧预检）、`DebugConfigManager.configWatcher`（`.kbengine/debug.json` 变更即重载）。缺的不是执行面，是**输入质量面**：components 空与文档密码错误都会让这些链路空转而无人知晓（除了 startDebugging 时的密码缺失单点提示）。telnet 端口偏离已知默认（如把 baseapp 填成 41000）时派生目标直接指向不存在的监听，报错发生在连接期而非配置期。
- **建议**：由 §5 的配置契约诊断在配置期就把三类输入问题（空 components、端口缺失/偏离、文档密码冲突）报掉；执行面保持现状即可。

## 4. 配置层诊断真空（Config-Layer Diagnostic Vacuum）

- **现状盘点**：kode 诊断面集中在 **数据定义层**——`.def` 结构校验、未知 Type/Flags/DetailLevel、重复定义、缺字段、段错配（receiverNone）、RPC 实参数、属性方向、只读写入、角色错用、销毁后访问、进程拓扑（process_topology.xml）、entities.xml 校验。全部 12+ 条诊断规则无一作用于**工作区配置文件**：`.kbengine/debug.json`、`.vscode/settings.json`（extraPaths）、`.gitignore`、CLAUDE.md/README 文档声明均为 0 覆盖。
- **为什么这是真空**：本次 6 项环境事实中 4 项（#1/#2/#3/#4）落在这一层；它们不报编译错、不报运行崩溃，只在「调试连不上 / import 解析不到 / 密码泄露 / 照文档操作失败」时才被人肉发现——发现成本最高的正是这一层。
- **建议**：落地「配置契约检查」诊断规则（§5），把此类 bug 从「人肉 review + 线上复现」变成「保存即报」。

## 5. 已落地：配置契约检查诊断规则（Config Contract Diagnostics）

- 模块：`src/configContractDiagnostics.ts`——`computeConfigContractFindings` 纯函数（不 import vscode，测试直跑）。检查项：
  1. debug.json：`components` 空/缺；已知组件（loginapp 31000 / dbmgr 32000 / interfaces 33000 / logger 34000 / baseapp 40000 / cellapp 50000 / bots 51000）telnet 端口缺失或偏离已知默认；telnet 段整段被注释（JSONC 文本层检出）；`telnetPassword` 与文档声明冲突。
  2. `python.analysis.extraPaths`：含 `../..` 双层上跳的条目（对 `kbe/typings` 相对语义错）；指向不存在目录的条目。
  3. `.gitignore` 缺 `.kbengine/`。
  4. CLAUDE.md/README 声明的密码/端口与 debug.json 实值冲突。
- 每条 finding 带 severity + 中英双语修复建议文案。
- 接线：独立诊断集合（`kbengine-config-contract`）、开关 `kbengine.configContractDiagnostics`（默认开）、工作区配置文件保存/打开即扫 + FileSystemWatcher 变更即重算（复用 `DebugConfigManager.configWatcher` 变更即重算模式与 receiverNoneDiagnostics 开关接线样板）。
- 测试：`tests/configContractDiagnostics.test.ts`（红先行，见该文件与 docs/features.md 对应条目）。

## 6. 引擎事实核对（事实 5/6 对 kode 工具面的含义）

- `messageTable.ts` 的 Utype 上限 65535（`METHOD_UTYPE_MAX`）与事实 5 的 `MessageLength`/Utype uint16 口径一致；但 `NETWORK_MESSAGE_LENGTH_SIZE=2`、≥65535 的 `MessageLength1`（uint32）扩展头、`PACKET_MAX_SIZE_TCP=1460` 尚无对应建模点——做 wire 级工具（抓包对拍、包长预算）时需补，且 grep `ENCRYPTION` 会漏 `ENCRYPTTION_WASTAGE_SIZE`（引擎原拼写少一个 P）。
- 事实 6（协议表握手期下发，`loginapp.cpp:1469` / `baseapp.cpp:4891`）印证 kode 现有路线：协议表面按会话快照采集（`sdkMessageNumberAudit.ts` / `messageTablePreview.ts`），不做静态全量表假设——此路线正确，内网机排查协议问题时应继续以握手快照为准，勿信离线表格。

## 7. 结论

| 维度 | 判定 |
|------|------|
| 工作区配置契约 | 4 项事实全部无覆盖 → 本次以诊断规则补上 |
| 离线可用性 | 修复在 `feat/kode-kr-c` 已做未合 → 需合入 + 内网复验 |
| telnet/调试集成 | 执行面齐全，输入质量面由新规则补 |
| 配置层诊断真空 | 是本次全部配置类事故的共同根因 → 新规则即杠杆 |
