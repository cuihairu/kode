# RUST-116 验收:语义 fixture 金标数据 + Rust/TS 差异分类账

日期:2026-11-16。验收对象:todo.md RUST-116(旧 SEM-014)「建立语义 fixture 金标数据,跨 Rust/TS 老逻辑差异必须人工分类审查」。

## 1. 判据词 → 实现面映射

| 判据词 | 实现面 | 语义 |
|---|---|---|
| 语义 fixture 金标数据 | `crates/kode-server/src/semantics_golden.rs`(`dump_semantics_golden`)+ frozen golden `crates/kode-server/tests/golden/semantics-facts.json` + 对拍测试 `tests/semantic_golden.rs` | 真实资产夹具 tests/fixtures/kbengine-demo-assets(65 语料文件)上,KSEM 纯库面产出整体快照:doclass 逐文件分类 65 行 / nav 三腿导航链 12 实体(含注册位属性+行号、def 段事实=hasXxx 旗标、Python 腿类位 AST 0 基)/ 忽略账 37 条(not-script-layout/entity-not-registered 诚实入账)/ 跨文件重复三面(干净语料钉空)/ rename 归属三分(语料逐 py + 内建/生成物两固定探针)。全数组显式排序,重放字节级可对拍 |
| 金标再生成纪律 | dump bin + 对拍测试失败文案 | 仅语料夹具或面语义变更时再生成;**差异必须先入本账(§3)人工审查,确认裁决后再再生成**——不得静默重生成吞掉 |
| 跨 Rust/TS 老逻辑差异必须人工分类审查 | 本文档 §3 分类账 | 裁决四档 = 精确升级 / 同语义双实现 / TS 独有消费面 / 真分歧待修;每条带证据(commit/测试/golden);**账内未登记的新差异不得合并**(纪律红线,测试失败文案内显式指回本账) |

## 2. 实现要点

- 模式沿 def-md5 golden 先例:dump bin(`cargo run -p kode-server --bin dump-semantics-golden`)+ 重放对拍(逐字节)+ 覆盖锚断言(corpusCount>20/Avatar 三腿/忽略账/两探针);
- 语料收集递归 read_dir 排序;doclass/nav/rename 分类复用既有纯库面(doclass/nav/rename_policy),零新语义逻辑——金标只做**快照与对拍**,不引入第二实现;
- 行号双口径原样保留(注册位 parser 1 基/类位 AST 0 基),逐字段在 golden 中可核;
- 模块测试 2 例(两次 dump 同字节/覆盖锚)+ 对拍测试 2 例(字节相等/锚面);

## 3. 差异分类账(人工分类审查记录)

| # | 面 | Rust 现状 | TS 老逻辑 | 裁决档 | 证据 |
|---|---|---|---|---|---|
| 1 | 实体注册重复(entities.xml 同名) | `doclass::duplicate_registrations`(RUST-112) | `entitiesXmlAnalysis` warning 诊断 | 同语义双实现(诊断发射属 TS 消费面,Rust 事实面待接线) | ba8fc3c3 / 引擎锚 entitydef.cpp:255-262 |
| 2 | 跨文件同池同名 def / 同文件重复类 | `doclass::duplicate_defs` / `duplicate_py_classes`(RUST-112,只报事实不选 winner) | 无对应 TS 面(lint `duplicate-definition` 只覆盖文件内) | Rust-only 新面 + 文件内面边界划分 | ba8fc3c3 |
| 3 | 实体三腿导航链 | `nav::EntityNavIndex`(RUST-110) | `defPythonParity`/`entityWizard` 布局推导(零散) | 同语义双实现(nav 统一面,消费接线归各域账行) | 14743c86 |
| 4 | 多 root 同名消解 | `roots::MultiRootRegistry`(RUST-111,显式序=IDE 约定) | 无对应 TS 面(引擎单 root 不合并) | Rust-only 新面(引擎真源边界诚实) | 7204b744 |
| 5 | 引擎 API/回调/内建对象/常量元数据 | `engine_meta`(RUST-113,seed 29 条+版本覆盖) | `engineVersion.ts` 版本设置键(PRESETS 归一) | 同语义双实现(版本归一属 TS 消费面,Rust 精确串不猜) | 4951883b |
| 6 | rename 归属策略与冲突预检 | `rename_policy`(RUST-114) | `defRenamer` def 成员级冲突(IDE-NAV-008/AUD-061) | 同语义双实现,成员级归 TS 不重复建模(RUST-114 模块 doc 钉边界) | 229f49a5 |
| 7 | Python 流推导(self_flow/typeOfExpr/localReturnType) | kode-python ruff AST 引擎 | TS 推导引擎(冻结为杀开关兜底) | **精确升级(已裁决)**——Rust 为主 TS 兜底,假阳性清除+真值补上 | d9765f08 / 92a24fc7 / d5e0bb74 / 81f57678(2026-11-11 精确性主车道 A→D) |
| 8 | def MD5 规范推导 | Rust 重放器(引擎 EntityDef::md5 字节序镜像) | TS defMd5Check | 字节对拍锁(golden: def-md5-parity.json) | 1cc63444 等 def-md5 账行 |
| 9 | provider 面(hover/completion/definition/diagnostics/flag-domains/wire) | Rust dispatch 输出 | TS provider 输出 | 字节对拍锁(golden: 6 份 *-parity.json) | crates/kode-server/tests/golden/ |
| 10 | 本金标(semantics-facts.json) | KSEM 纯库面快照 | 无逐面对应 TS 老逻辑(各面裁决见 #1-#6) | 快照锁(本账载体;后续重放差异按四档入账) | 本批 |
| 11 | 语料夹具行号位移(MRO-CHAIN demo 扩展:TrainingAvatar/TrainingMonster 尾追加 onCrossDay 遍历调度器) | `doclass` 两处 `class_end_line` 46→58 / 23→34,零语义事实增删(方法级事实不在采集面) | 无涉(纯夹具变更) | 夹具扩展快照锁步——裁决=预期位移,再生成合法 | 4ee6aae3(载体)/本批 MRO-CHAIN |

账内规则:后续任何重放/对拍发现的新差异,**先入本表补行并给裁决档+证据,再谈合并**;「真分歧待修」档的修复必须有独立账行驱动,不允许借再生成静默对齐。

## 4. 测试与 prove-red

- 模块 2 例(dump 两次同字节/覆盖锚=语料规模+Avatar hasXxx 三段+忽略账+内建/生成物探针)+ 对拍 2 例(重放字节相等/锚面);
- prove-red 三靶(cp 备份+python3 变异+cmp 字节还原):① doclass 标签串变异 → 重放字节红;② 忽略账静默吞(not 入账)→ 重放红;③ def 段事实丢旗标 → 重放红(覆盖锚前置字节闸)。

## 5. 门禁(2026-11-16 实跑)

见 todo 勾行(与 RUST-114 批同轮全门禁口径;本批新增 semantic_golden 4 例 + golden 1045 行)。

## 6. 结论

判据词全落:语义 fixture 金标(真实资产语料全量快照+字节对拍+再生成纪律)与差异分类账(四档裁决+证据+合并红线)。整行 `[x]` 勾账。
