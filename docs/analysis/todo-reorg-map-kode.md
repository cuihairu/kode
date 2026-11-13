# kode todo.md 重整映射表(2026-11-14,巡检单 kode-todoreorg 执行件)

**性质**:重整前置产物——旧编号→新功能域映射 + 结构方案 + 抽检策略。评审通过后动正文;正文落盘单 commit。

## 0. 前提修正(任务书双账本前提已过时)

任务书前提「主 todo.md(产品)与 docs/kode2/KODE_2_COMPLETE_TODO.md(Rust Core)维持分账、两边重整互链」**已被 2026-11-13 的账本合并取代**:todo.md L2016 起「Kode 2.0 — Rust Core 高性能重构账本(自 docs/kode2/KODE_2_COMPLETE_TODO.md 合并,2026-11-13)」,原文件已不存在,合并核对结论在 todo.md「账本合并核对(2026-11-13)」节(52 项逐族判定零重复、kode2 已勾 60 项抽查 10/10 证据成立)。本次重整按**单一统一账本**执行;头部「分账约定」指针改指该合并节,不再指向已删除文件。

## 1. 重整结构方案(2026-11-14 落地修订)

- **Active(按功能域分节)**:47 个含未勾条目的分节重新归域(实际扫描数,非预估的 26);域内 `<域>-NNN` 按原账本出现顺序重编号(旧行文全保留,含「进行中:」注记原样)。
- **落地修订:不做 Active/Completed 域内重排**(§1 原案「Active 在前、Completed 在后」作废)——条目普遍跨行、夹表格与续文,重排会打散行文且徒增错位风险;改为头部索引表逐域给 未勾/已勾 两列计数,总口径不变(重整前后 1563 条/1173 勾全等,逐行保真校验过)。
- **Archive(尾节,不重编号)**:全部已勾历史分节**整节搬运**到尾部 `Archive(历史凭证,编号为旧制)`,原节标题与旧编号原样保留(含「2026-11-14 重整核对」注记);git 历史即档案。被拆分的「KBEngine 语义精度与跨进程流转重做」节在 Archive 留重整注记,余留分节原样。
- **头部索引**:域 → 名称 → 未勾 → 已勾 一张表(SEM 23/24、FLOW 29/0、HOT 2/5、RUST 328/121、EXEC 1/7、DIST 1/6、QA 6/0)。
- HR-MOD/HR-HTTP 被 HR-PR 行覆盖子项的合并规则:**空转核实**——全部 HR 分节 2026-11-13 接线批收官后已全勾(不在 mixed 集合),无未勾子项可合并;Archive 整节搬运时原样保留。
- **features.md 引用处置(落地修订)**:en/zh 各 54 处 `todo.md:NN` 行号指针在 HEAD 已普遍失锚(指向空白行/无关条目,系账本多次重排的历史残迹),重整不再搬运失效指针——全部移除,证据保留命令/配置键/源码路径/测试四类实指;tests/ 六处注释引用(configDeriveScanRoot/entryScriptBreakpoint/telnetDeriveTargets/readOnlyWrite/roleMisuse/postDestroy)同批修正到真实属主条目新行号(KODE-CFG-005/006/007、IDE-LINT-007/009/010)。

## 2. 功能域定义与成员映射

| 域 | 名称 | 覆盖(前缀/分节) | Active 来源分节(todo.md 行) |
|---|---|---|---|
| SEM | KBEngine 语义分析 | KSEM-BAS/CELL/STRUCT/RPC/CREATE/SER/CFG/DATA、SEM、KBE*、SYNTAX、SCOPE、TYP/ARRAY、GEN-DEF、KB-GC、GLOBDATA、IFACE-MERGE、FIXED、RCV-GUARD、NAV-REF-PROP、KBEXP | KSEM-CELL(L181)、KSEM-SER(L240)、KSEM-CFG(L259)、KSEM-DATA(L275) |
| LANG | Python 语言服务 | IDE-HOV/NAV/LINT、PY*、pyi、LANG-NAR、KODE-PYRIGHT | —(Active 空;历史在 Archive) |
| IDX | 索引与事件 CodeLens | IDE-IDX、IDX、IDE-EVT | — |
| DIAG | 诊断族与缺陷修复 | KBUG-*、IDE-DIA、AUD-KODE-P1 | — |
| FLOW | 进程流转与调用树 | KFLOW-CORE/UI/TRACE | KFLOW-CORE(L286)、KFLOW-UI(L304)、KFLOW-TRACE(L317) |
| HOT | 热更新 | HR-WATCH/HTTP/HASH/MOD/UI/STATE/AUDIT/EXT/DOD/PR/DEMO、KODE-HOT | Demo 双通道热更新(L49) |
| RUST | Rust Core 重构 | RUST-*、IDE-RUST、L0-L11、PH*/PH*-GATE、PA、SP、A1-A7、PROC-TAG、ANCHOR-RELOCK、kode2 合并节 | Kode 2.0 全节(L2016-2559,17 个子节) |
| PERF | 性能治理 | PERF、KODE-PERF、P0、IDE-BUD | — |
| UI | 工作台/UX/i18n | UX-REVIEW、UI、IDE-ACC/LIV/I18N、KODE-I18N、CLONE-*、KODE-REDIS-UI、DB-MGMT、KDB-EXPORT | — |
| EXEC | 后台执行与调试 | EXEC、IDE-DBG/PDBG、KODE-DBG、DBG-COMPAT、background/debug | Python 3.7.3 调试工具链(L36) |
| CFG | 配置先行架构 | KODE-CFG* | —(Active 空;KODE-CFG 未勾项在 Rust Core 节内) |
| DATA | 数据面/快照/DB | IDE-DB/SNP/SCH | — |
| PRJ | 项目模型/生成/运行 | IDE-PRJ/GEN/RUN/TSK/ARC/WARM/MET | — |
| DIST | 分发/插件/npm | PLUG、NPM-PKG、NIGHTLY-PLATFORM、IDE-REL/SDK、CI | kode-mcp 上 npm(L19) |
| QA | 质量门禁/测试 | QA、FLAGS-AUDIT、KODE-GATE-MOCHA、QACT-TERM、KSEM-QA | KSEM-QA(L330) |
| ENV | venv/环境 | PY-ENV | — |
| MCP | MCP 通道 | KODE-MCP-* | —(KODE-MCP-KB 余量在 Rust Core 节) |
| ARCH | 架构决策 | ARCH、ADR、KODE-ARCH | —(Active 归 Rust Core「18. 关键架构决策」节) |
| DOC | 文档/demo 夹具 | DEMO-GAME、KODE-DOCS-AUD、KODE-FEAT | — |

(「—」= 该域 Active 现状零条目,索引表如实标 0;全部历史在 Archive。)

## 3. 旧→新编号规则

1. Active 条目:按域分节内**原账本出现顺序**编 `<域>-NNN`(001 起);旧 ID 在行文内首次出现处以「(旧 KSEM-SER-10)」形式保留一次引用,此后行文原样。
2. Archive 条目:编号为旧制,不改不引。
3. 无前缀条目(122 条):按所属分节归域(见 §2 Active 来源);分节外游离的归 RUST(kode2 节)或其分节域。

## 4. 勾选核对抽检策略(铁律 1)

- 抽样口径:**每域抽 20% 已勾条目**核对源码(找真实入口 file:line,确认「能跑」而非占位);全账 1173 勿需逐条。
- 优先域:含「进行中:」注记的域(全账 33 条,集中域加倍抽);虚勾一经发现,该域扩抽到 50%。
- kode 特有信任基线:本账勾行纪律=勾行带 commit hash + 自我验收(kode-parked-no-autopilot 台账),抽检以「勾行注记 hash 可追溯 + 源码入口存在」双证为准;hash 注记缺失且源码无入口的判虚勾。
- 核对结论全部落重整报告(取消勾选清单带 file:line)。

## 5. features.md 双语同步策略(铁律 4 + 补充规则)

- 现状:docs/features.md(en,549 行)+ docs/zh/features.md(zh,510 行)镜像 8 节,另有 149 行 Settings 表;**无 ID 列、无 Status 列**——现状快照以节为粒度。
- 动作:(a) 每节标题注记对应新域 ID(如 `## Def & Entity Intelligence(SEM)`),zh 镜像逐节对应;(b) 核对节内关键能力声明与源码实态(优先抽 Settings 表与声明性强的行)——声明了但源码没有的:节内降级/注明 + todo.md 补未勾条目(引用 features.md 行号 + 缺口范围);实现了但口径过谦的升级;(c) 只到模块级 + 关键能力行,不逐脚本函数展开;(d) 不新建文件、不改表格形状。
- 双语同步:en 改动逐节镜像进 zh;两边核对结论一致。

## 6. 门禁与交付

- 门禁:不动代码;`npx tsc --noEmit` + `pnpm exec vitest run tests/extension.test.ts` 抽查仓健康;单 commit `docs: reorganize todo by feature domain`(含 todo.md + features.md en/zh + 本映射表)。
- 交付:重整报告(核对条数/取消勾选数带证据/删除数/映射要点)发用户确认格式,再谈舰队推广。
