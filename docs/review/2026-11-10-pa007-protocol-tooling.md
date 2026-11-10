# PA-007 交付证据（Phase 5 Kode 协议工具集成）2026-11-10

## 项面

PA-007 验收：用户零手动配置。Protocol Analyzer 命令 + 协议管理面板；
Wireshark/TShark/插件版本检测；Schema 自动生成与协议文件变化监听（仅协议
定义文件触发重建，Python 业务变更不触发）；一键开 PCAP/跑 TShark；
Schema 版本提示 + 错误诊断。前置：PA-004、PA-006。

本批为**勾账确认**：四项增量均已在前置会话交付并登记于 features.md
（交付账本）286–293 行，本文件逐条对照验收准则并附本机门禁证据，
不新增实现。

## 验收准则逐条对照（features.md 增量 → 实现 → 证据）

1. **Protocol Analyzer 命令 + 协议管理面板**：`kbengine.protocol.showStatus`
   采集机器协议工具链状态，渲染进「KBEngine Protocol Tooling」输出通道
   （面板=输出通道面，`output.show(true)` 抬到前台）。
   证据：features.md:286；src/protocolTooling.ts、src/backend/protocolToolingDetect.ts、
   src/activate/infrastructure.ts:109 `setupProtocolTooling`、
   package.json#contributes.commands `kbengine.protocol.showStatus`。
2. **Wireshark/TShark/插件版本检测**：`tshark -v` 首行 / Wireshark GUI 版本
   （缺失如实报 absent，不猜）/ 插件目录（`tshark -G folders`）/ KBEngine
   dissector 插件（type=dissector+name 匹配，插件目录 vs 宿主版本行三态：
   匹配/不匹配「host will not load」/路径无 `plugins/<maj.min>` 形态=unknown）/
   kode-kbengine CLI（`target/{debug,release}` 自动发现或
   `kbengine.protocol.cliPath` 覆盖，`--version` 一行契约）。
   证据：features.md:286；解析面纯函数，fixture 取真实 tshark 4.6.4 输出字节
   （tests/protocolTooling.test.ts 14 例、tests/protocolToolingDetect.test.ts 22 例）。
3. **Schema 自动生成 + 协议文件变化监听（仅协议定义触发）**：
   `kbengine.protocol.buildSchema` 命令 + `kbengine.protocol.schemaAutoBuild`
   （默认 on）`*.def`/`types.xml`/`entities.xml`/`alias.xml` 监听自动重建；
   事件根复用 `kbengine.assetsRoot` 发现链，根外事件不触发；Python 结构性
   排除（监听 glob 无 `*.py` 条目，非运行时后过滤）；构建串行防重入。
   证据：features.md:288；src/protocolSchemaSync.ts（watcher glob 无 *.py）、
   src/activate/infrastructure.ts:112 `setupProtocolSchemaSync`、
   tests/protocolSchemaSync.test.ts 15 例。
4. **一键开 PCAP/跑 TShark**：`kbengine.protocol.openPcap` 启 Wireshark GUI
   （无超时，防检测面 5s 探针预算杀刚启 GUI）；`kbengine.protocol.analyzePcap`
   跑零 ABI 路径 `kode-kbengine capture analyze --pcap <file> --tshark <tsharkPath>`
   （插件非必需），CLI 报告逐字渲染进输出通道（不重排）；分析面自带 120s
   长超时。证据：features.md:290；src/protocolPcapActions.ts、
   src/activate/infrastructure.ts:115 `setupProtocolPcapActions`、
   tests/protocolPcapActions.test.ts 9 例（含 1 例真实 execFile 收敛语义）。
5. **Schema 版本提示 + 错误诊断**：`showStatus` 尾部 schema 段读
   `globalStorage/kbengine-schema.json`——生成→IR 版本/引擎基线/消息与实体数/
   缺失实体（entities.xml 登记但无 .def）/CLI 构建诊断逐字列（SYNTAX-005 约定：
   坏输入保留为可定位诊断，不假装通过）；未生成→buildSchema 提示；
   不可读/坏 JSON→原因。证据：features.md:292；
   src/protocolSchemaSync.ts `readSchemaState`、
   src/protocolTooling.ts `renderProtocolToolingStatus` schema 段、
   tests/protocolSchemaSync.test.ts readSchemaState 6 例、
   tests/protocolTooling.test.ts schema 段 5 例。

## 门禁（2026-11-10 本机实跑）

- `pnpm lint` 0。
- `pnpm test:unit`：695 文件 8421 过 8 skip，RC=0（含本批全部 protocol
  tooling 测试：protocolTooling/protocolToolingDetect/protocolSchemaSync/
  protocolPcapActions/kbengineProtocol* 等）。
- `pnpm docs:build` RC=0（vitepress SSR 警告非错误，build complete）。

## 边界声明

- **真实桌面走查不在本批**：检测/动作面经 fixture（真 4.6.4 输出字节）+注入
  驱动，非真机端到端。从安装包在真实 Windows/macOS/Linux 桌面执行属
  **UX-REVIEW-009b/009c/009d**（「不得以源码/模拟测试替代」，另立项勾账），
  PA-007 验收不覆盖该面，此处不越权声称。
- 前置 PA-004（CLI，含 `capture analyze`）与 PA-006（Wireshark 插件）均已勾；
  PA-006 的 Windows 实机加载验证 2026-11-10 imac 完成（见
  docs/design/pa006-wireshark-plugin.md，3b7357c8），即 PA-007 依赖链闭合。
