# UX-REVIEW-009d 走查问题汇总与边界确认 2026-11-11

汇总 UX-REVIEW-009b(Windows imac 真机四阶段 A/A2/B/C)与 009c(Linux xvfb
双形态 + Windows 纯 TS 包)三轮走查的全部问题,逐条给处置/修复前后证据;
确认只读/写入边界与既有入口可达性未因走查及后续修复降低;尚未满足的验收
逐条保留开放(本行明确要求「不能批量勾完成」)。

证据源:docs/ux/2026-11-10-walkthrough-009a.md(场景)、
docs/ux/2026-11-10-walkthrough-009b.md(imac 汇总)、
~/pa007-evidence/009b-stage{A,A2,B,C}-report.md + sA*/sA2*/sB*/sC* 截图、
~/pa007-evidence/009c-linux-report.md + pl_*/pu_* 截图、
~/pa007-evidence/009c-windows-purets-report.md + pt_* 截图、
c_def_output.log / c_discovery_report.log。包均从干净 HEAD d7f092a2 构建
(版本 0.2.0);本批未改走查覆盖到的行为面。

## 一、问题台账(三轮 29 条原始记录,按主题归并 18 项)

### 已破案/已修正判词(修复前后证据齐)

| # | 问题(原始出处) | 修复前后 |
|---|---|---|
| 1 | 实体区「只剩 Types 5」,Entities/Interfaces/Components 不见——三轮全部中招的最大困惑(A2#3、B#1/#2、Linux#9、WinTS G1/G2) | **前**=判词「实体分组缺失,跨 OS 跨形态复现」;**后**=2026-11-10 14:30-14:40 破案作废:数据层健康(Node 探针 getDefinitionEntries 四组齐 Types 5/Entities 9/Interfaces 2/Components 1)、渲染层健康(折叠 Types 后 Entities 9 即现 probe_tree_05/pt_03,键盘 End 滚到底后两组全现 probe_tree_08/pt_04),def 分析 12 def 全枚举互证(c_def_output.log)。真因=多视图侧栏高度压缩把后三组压在折叠线以下、零滚动提示。**保留的真实缺陷=可发现性,登记 UX-REVIEW-011(设计决策待用户,保持开放)** |
| 2 | 「def 分析未跑导致实体缺失」假设(Stage C 排查动机) | 已否定:getDefinitionEntries 直读 entities.xml+entity_defs 不依赖 def 分析(src/definitionWorkspace.ts:1291);sC_07/08/11 重载+分析前后树形态不变 |

### 判定为合格防线(非缺陷,实测生效)

| # | 面 | 证据 |
|---|---|---|
| 3 | 快速执行 confirm:true 防线:7 条动作全带确认,误触被挡(safe_kill.bat 点 Cancel 未执行) | imac Stage B 观察面 + Linux pl_06/07 同源复测 |
| 4 | 只读查询密码不可解即不查询:RSA 密文不可解 → toast「Password unreadable … — not queried」+ Retry/View details,无假数据、无密码回显 | Linux pl_15/16 |
| 5 | telnet 诚实降级:无密码停在 Auth required+Connect session 按钮、无命令输入框(无写入路径);无引擎时 showPanel 报完整降级原因 | imac Stage B + WinTS pt_09 |
| 6 | 导出预检先于上下文收集(004b):缺配置 → toast「Source connection is not configured.」+「Configure source connection」入口,零实体/DBID 收集;向导 Source 1/5 可开 | Linux pl_06/07 + WinTS pt_07/08;自动化回归=UX-REVIEW-004e(2cf6acb4,tests/cloneBoundaryRegression.test.ts)+本批 a041f614 扩展三预检(后端闸/连接测试/派生前置);**真机腿 2026-11-11 已补**(Linux xvfb,报告 ~/pa007-evidence/004b-newarm-linux-report.md:缺配置 toast nb_03/探针失败 ECONNREFUSED 双入口 nb_08+通知中心复败核验 nb_09b/向导预填改配置续探过→实体选择 nb_10..nb_23/派生前置先于 DBID+Esc 零收集 nb_24/25;顺带抓出桩包模板未进 VSIX 打包缺口,b849f006 修;内联续接与推导失败臂保持单测口径如实标) |
| 7 | 纯 TS 包零 rust 痕迹:exthost 日志 grep rust/kode-server 零命中、无原生二进制、out/ 全 JS、backend 默认 ts(设置兼容层保留 rust/shadow 枚举) | WinTS §A 全表 + pt_settings_backend.png + Linux 双通道日志 |
| 8 | 信任还原可审计:security.workspace.trust.enabled 还原后键不存在(0 出现),与 settings.json.bak-009bC diff IDENTICAL;纯 TS 腿全程零碰全局 settings.json(收尾逐字核对 backend:"rust" 仍在) | Stage C 报告 + WinTS §0/收尾 |

### 保留开放(如实,未修——多为文案/可发现性改进候选,无功能缺陷)

| # | 问题(出处) | 处置 |
|---|---|---|
| 9 | K 图标活动栏第 10 位无文字标签;状态栏 3 项混入 codicon 名(Stage A) | 保留,改进候选 |
| 10 | 空目录扫描无中间进度态(Stage A) | 保留 |
| 11 | 侧栏不自动开,首用「装了扩展没东西」(A2#2);Restricted Mode 全英文横幅(Stage A) | 平台行为,保留 |
| 12 | discovery 命令难搜(要搜 "discovery" 才靠前);报告问题主动提示**判词分歧如实记录**:imac 侧 A2#5 观察为「无主动通知」,Linux 侧 pl_08 实测有「1 discovery issues found」toast——两轮观察不一致,不强行统一 | 保留 + 分歧留档 |
| 13 | machined unreachable 文案偏技术("20086/stale snapshot")(A2#6、B#5) | 保留,文案改进候选 |
| 14 | Get Started「View entities」点击无反应(A2#7) | 单轮观察未复现追查,保留开放 |
| 15 | Quick Action 标签过长截断噪音(A2#8) | 保留 |
| 16 | 服务器全 stopped 无启动引导(B#6);telnet 只读命令无入口=可用性缺口(B#3);def 分析命令中文名难搜(B#7);binPath 补救无设置跳转(WinTS G4);telnet 降级文案长(WinTS G6) | 保留 |
| 17 | 纯 TS Player Data 显示「Database config section not found」而平台包显示 DSN,差异无解释文案(Linux#10、WinTS G3) | 根因=RUST-MIGRATION-AUDIT-007(纯 TS 无 config/resolve TS 回退,实机证实,审计 007 预判命中),处置待用户;文案改进候选保留 |
| 18 | Remote Servers 直列 ~/.ssh/config 主机,来源用途无解释(Linux#11);命令面板中文输入乱码(B#8——UIA SendKeys 注入手段限制,非产品缺陷,如实标注) | 保留 |

## 二、只读/写入边界确认(未降低)

- 走查全程**零写入、零回滚需求**:三轮走查均为只读观察,唯一状态变更
  (trust 开关)已还原并逐字核验(#8);场景目录只读未改(WinTS §0)。
- 只读查询面:失败即不查询、不造假数据(#4)。
- 写入前置闸:导出预检先于一切收集(#6);导入面未在真机走查,自动化
  结构锁在案(004e:语句白名单 executor、环境闸非 local/test 拒绝、
  Rust fail-closed 复核、Target 必须 local/test)。
- 快速执行面:confirm:true 全覆盖且实测挡住误触(#3)。
- 后端边界:纯 TS 包不假称有 Rust(#7),归档/规划操作无 TS 兜底口径不变。

## 三、既有入口可达性确认(未降低)

- 侧栏 12 视图齐(imac A2「12 视图齐」+ Linux pl_04 + WinTS §B 清单);
  23 个 Output 通道全在(Linux 纯 TS 腿)。
- Get Started 四入口、Quick Actions 7 条、Servers 6 组件、Discovery Report
  命令、clone.export 命令、telnet.showPanel 命令全部实测可达(各报告对应行)。
- 信任模式(Restricted Mode)下贡献点不注册=「激活但不呈现」,VS Code
  标准行为非退化(sC_13)。
- 预检失败面自带补救入口(Configure source connection、Retry connection test、
  View details、discovery 补救链文案)。

## 四、尚未满足的验收(逐条保留开放,不勾)

1. **UX-REVIEW-011**:实体区可发现性改进(置顶/默认折叠/徽章外露)——设计决策待用户。
2. **RUST-MIGRATION-AUDIT-007**:纯 TS config/resolve 回退补齐 or 文档声明能力边界——待用户。
3. **macOS 真机腿**:按用户令 2026-11-10 只编译不测试(nightly darwin 双架构全绿 run 42752103203),真机走查不做。
4. **无障碍/读屏**:xvfb 与 UIA 树均非读屏视角,未走查。
5. **imac 侧折叠/滚轮复核**:Restricted Mode 下 KBEngine 视图不注册,sC_12 未完成(Linux/WinTS 侧已证,判词不依赖此腿)。
6. **克隆向导完整流程**:a041f614 三预检臂真机腿 2026-11-11 已补(缺配置 toast/探针失败重试·配置循环/派生前置先于 DBID+Esc 零收集,报告 ~/pa007-evidence/004b-newarm-linux-report.md;顺带抓出桩包模板未进 VSIX 的打包缺口,b849f006 修)。仍开放:向导走完→实际导出→导入真机未执行(零写入纪律);单次运行内 probe-fail→Configure→续探→继续收集的内联续接、推导失败臂保持单测口径;后端闸缺席臂按设计只在核心装配异常态可达(kodeCoreGateWiring.ts:114 ts/rust 两模式均装配门,纯 TS 腿实测闸通过),真机不可安全复现,保持单测+prove-red。
7. **telnet 实连**:无密码真实引擎止步 Auth required,配置密码后的实连未做。
8. **服务器完整生命周期**(启动/热更/关闭对真实引擎组):场景 5 只覆盖入口与状态面。
9. **Stage A 观察项**(#9/#10/#14 等):单轮观察未复现,保留。
