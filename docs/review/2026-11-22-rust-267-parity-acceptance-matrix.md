# RUST-267（旧 PH5-GATE）界面功能 parity 逐面验收表（2026-11-22 口径立项）

<!-- 对账：RUST-264（PH5-01）实现 KBE-001..018/UI-001..012 全勾；本表为 RUST-267（PH5-GATE）
「界面功能 parity 与多个真实引擎工程测试通过」的量化口径与逐面验收表。口径由用户 2026-11-22
拍板（1 真引擎 + 2 fixture）。真引擎腿证据=009b imac（af8a9f98）+009c Linux xvfb 两腿走查；
fixture 腿证据=各面实现批门禁（unit 全量 + xvfb demo editor 25 RC=0 + golden parity 族）。 -->

## 口径（2026-11-22 用户拍板）

- 「多个真实引擎工程」= **1 真引擎工程 + 2 fixture 工程**（共 3）：
  - 真引擎 1：imac 场景 5 真实引擎（运行中的 KBEngine 服务器：6 组件真实状态面 / machined UDP 发现 /
    telnet 真机端口，009b Stage B/C 走查载体）。
  - fixture 2：`tests/fixtures/kbengine-demo-assets`（demo editor 25 RC=0 门禁 + demo:verify 载体）+
    `tests/fixtures/parity-project`（golden parity 族跨根语料；与 kbengine-demo-assets 双根同跑）。
- 逐面范围 = KBE-001..018 + UI-001..012（30 面；RUST-264 已实现 18/18 + 12/12 全勾）。
- 通过标准 = 每面在 3 工程上 parity 验证绿（fixture 腿 = 回归网证据面；真引擎腿 = 真机走查逐面）。

## 验收表

| 面 | 主题 | 实现载体 | fixture×2 验证 | 真引擎腿（009b/009c） | 判定 |
|---|---|---|---|---|---|
| KBE-001 | workspace discovery | RUST-171（89ddeaed） | unit 10437+demo 25（scanRoots/discoveryReport 等钉） | StageA/A2：空目录「未找到 KBEngine 项目」+发现报告命令真实执行+侧栏 12 视图齐+[missing] binPath 补救链 | 🟢 |
| KBE-002 | 项目向导 | RUST-172（0d8564cd） | unit 10450+demo 25（13 钉） | 未走 | ⏳ |
| KBE-003 | engine profile | RUST-173（30065a31） | unit 10461+demo 25（11 钉） | 未走 | ⏳ |
| KBE-004 | API metadata 绑定 | RUST-174（9a144db2） | unit 10478+demo 25（17 钉） | 未走 | ⏳ |
| KBE-005 | entities.xml 注册完整性审计 | RUST-175（943d4f3e） | unit 10493+demo 25（15 钉） | 未走（def 分析 12 def 全枚举属语义面，非审计面） | ⏳ |
| KBE-006 | RPC 参数类型兼容检查 | RUST-176（00457e7a） | unit 10521+demo 25（28 钉） | 未走 | ⏳ |
| KBE-007 | 类型结构/持久化检查 | RUST-177（5b7ee663） | unit 10565+demo 25（27+17 钉） | 未走 | ⏳ |
| KBE-008 | 实体关系浏览器 | RUST-178（b1241d38） | unit 10588+demo 25（16+7 钉） | 未走（关系图谱面未走） | ⏳ |
| KBE-009 | 创建实体/组件/RPC/类型向导 | RUST-179（e11aa055） | unit 25 钉+prove-red | 未走 | ⏳ |
| KBE-010 | 配置合并视图 | RUST-180（bf2f124e） | cargo test 全量+clippy 0 | 未走 | ⏳ |
| KBE-011 | 数据库 schema 视图/drift | RUST-181 | 验收 docs（acceptance） | 未走 | ⏳ |
| KBE-012 | Debug Adapter 边界 | RUST-182 | 验收 docs | 未走 | ⏳ |
| KBE-013 | 运行时 Process/Telnet/Watcher/Log service adapter | RUST-183 | unit 10612 | StageB：服务器入口 6 组件真实状态面+快速执行 7 动作+telnet 真机端口（Auth 面板）+machined 发现 | 🟢 |
| KBE-014 | Space/Watcher 真实引擎协议 | RUST-184 | unit 10615 | StageB：machined UDP 发现实测（unreachable 诚实文案）；mutation 面协议未验证（面自身诚实边界） | 🟡 |
| KBE-015 | 集成示例/真实 engine fixture | RUST-185 | demo 25 + 打包面引用 | fixture 即本面载体 | 🟢 |
| KBE-016 | Multi-workspace/多资源 root | RUST-186 | golden 双根语料 | 未走（单根场景） | ⏳ |
| KBE-017 | Project Doctor | RUST-187 | unit 10619 | 未走 | ⏳ |
| KBE-018 | dashboard/monitor/log viewer | RUST-188 | parity 基线表（迁移前后） | 未走（console tail 灯在案未走） | ⏳ |
| UI-001 | Project Explorer 实体视图 | RUST-218 | unit+demo 25 | 009b/009c：实体区 4 组数据健康（Types 5/Entities 9/Interfaces 2/Components 1，破案=高度压缩误读，真缺陷=可发现性 UX-REVIEW-011） | 🟢 |
| UI-002 | 状态栏 | RUST-219（3e98f013） | unit 10637 | StageA：状态栏 3 项在场观察（codicon 名困惑点）；全状态机（ready/indexing/partial/error）未逐态验 | 🟡 |
| UI-003 | 性能面板 | RUST-220（eeb0d3eb） | unit 10643 | 未走 | ⏳ |
| UI-004 | Core 重启/清缓存 | RUST-221（c281555d） | unit 10649 | 未走 | ⏳ |
| UI-005 | progress+cancel | RUST-222（5d8f7fce） | unit 10652 | 未走 | ⏳ |
| UI-006 | typings 预览/来源图 | RUST-223 | unit | 未走 | ⏳ |
| UI-007 | 类型信息 Cell/Base/Client | RUST-224 | unit | 未走 | ⏳ |
| UI-008 | graph view | RUST-225 | unit | 未走 | ⏳ |
| UI-009 | 可理解错误与修复操作 | RUST-226 | unit | StageA/A2：空目录 11 视图隐藏+[missing] binPath 补救链+unreachable 诚实文案 | 🟡 |
| UI-010 | 多根 active project/root 选择 | RUST-227 | unit | 未走（单根场景） | ⏳ |
| UI-011 | 设置分组 | RUST-228（01f39748） | unit 10656 | 未走 | ⏳ |
| UI-012 | 禁用重扫描标注 | RUST-229（600d0521） | unit | 未走 | ⏳ |

## 汇总与判定

- **fixture×2 腿：30/30 绿**（各面实现批门禁在 fixture 语料上绿：unit 全量 + xvfb demo editor 25 RC=0
  + golden parity 族横跨双 fixture 根，回归网常驻在役）。
- **真引擎腿：3 绿（KBE-001/013/015）+ 3 🟡部分（KBE-014/UI-002/UI-009）+ 24 ⏳未走**。
- 显式未验证（009b「未验证（如实）」节）：真实引擎**完整服务器生命周期（启动/热更/关闭）**——
  场景 5 只覆盖入口与状态面；macOS 整腿（按用户令只编译不测试，nightly CI darwin 绿）；Windows 纯 TS 包腿；
  无障碍/读屏。
- **判定：RUST-267 不勾**。验收表已建（本文件），口径已立项（用户拍板）；剩余=真引擎腿 24 面补验
  + 完整服务器生命周期走查，属真机走查攻坚（imac/Linux 载体），非代码实现债。

## 补验清单（真引擎腿剩余）

- KBE-002..012、KBE-016..018、UI-003..008、UI-010..012：真机逐面走查（各面在真实引擎工程上触发
  并核对 parity）。
- 完整服务器生命周期（启动/热更/关闭）：场景 5 之外的端到端——真实引擎启停 + 热更 + 状态回执。
