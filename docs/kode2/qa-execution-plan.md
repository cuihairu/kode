# QA-001..017 执行计划（v0.2.0 发布门禁）

- 日期：2026-11-03 · 仓：/home/cui/workspaces/kode（分支 main，工作树有未提交改动）
- 依据：`docs/kode2/KODE_2_COMPLETE_TODO.md` §14（L348-364）+ §15 PH7-01（L407）
- 性质：**只读评估 + 计划**。本文档不改任何源码；除本文档外未写入仓库任何文件。
- 评估方法：逐项到源码/工作流核实并附 file:line；实跑两条基线命令取真实数字（见 §2）。

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 分桶统计 | 桶1「立即可开工（无前置）」**10 项**；桶2「需先完成某项」**5 项**；桶3「需外部条件」**2 项** |
| 桶1 项名 | QA-004、QA-006、QA-009、QA-010、QA-011、QA-012、QA-014、QA-015、QA-016、QA-017 |
| 桶2 项名 | QA-001（←KODE-AUD-006 收口 + cargo 进 CI）、QA-002（←QA-001）、QA-003（←QA-001）、QA-005（←QA-004 的 hover/completion shadow 接线 + CI xvfb）、QA-013（←固定基准机/runner 稳定） |
| 桶3 项名 | QA-007（多平台 runner）、QA-008（真实引擎多版本/fork 检出） |
| 整体估算 | **40–45 人日**（含 4 项降级范围）；**2 人 × 4 周可完成；1 人 × 4 周只能完成约 10 项**（见 §7） |
| 3–4 周内根本不可能全量完成的 | QA-007 全矩阵、QA-008 版本/fork 矩阵、QA-009「恶意插件」面、QA-013 CI 硬性能阈值——均给降级方案（§6），不虚估 |
| 当前基线（实跑） | `cargo test --workspace --all-targets --no-fail-fast`：76 个测试二进制、441 passed、**1 个二进制崩溃**；`pnpm test:unit`：**5664 passed / 1 failed / 7 skipped** |
| 发布判定句 | 见 §8 |

---

## 1. 17 项逐项现状（均经源码核实）

图例：**已有** = 现状满足或基本满足；**部分** = 有底子但有明确缺口；**缺失** = 无底子。
桶 = §4 分桶；估 = 剩余工作量（人日，中值）。

### QA-001 Unit: parser errors / byte spans / UTF-16 position / alias cycles / entity facets / source map
- 现状：**大部分已有，可立即开工**（但整项无法签收，因 Rust 测试不进 CI）。
- 证据：
  - parser errors：`crates/kode-parser/tests/parser_units.rs:127`（error_recovery_truncated_never_panics_never_drops_tree）、`:153`、`:176`
  - byte spans：`crates/kode-parser/tests/parser_units.rs:11`（byte_spans_are_exact）、`:32`（attributes 保留 name/value span）
  - UTF-16 position：`crates/kode-vfs/tests/coordinates.rs:129/137/146/155`（ASCII/CRLF/emoji/混合全坐标双向扫描）、`:192`（ranged edits）
  - alias cycles：`crates/kode-types/tests/types_units.rs:95`（alias_cycle_is_diagnosed_and_terminates）；parent 链环 `crates/kode-parser/tests/parser_units.rs:318`
  - entity facets：`crates/kode-index/tests/index_units.rs:171`、`crates/kode-index/tests/symbol_golden.rs:63`（方法缺分面即红）
  - source map：TS 面 `src/generatedSourceMap.ts` + `tests/generatedSourceMap.test.ts`；**Rust 侧无 source map 概念**（生成面未迁），需在验收口径里显式界定为「TS 面已覆盖 / Rust 面记 0.3」
- 缺口：`grep -rn cargo .github/workflows/*.yml` **0 命中** → cargo test/clippy 从未在 CI 跑；且当前本地 1 个测试二进制崩溃（见 §2）。
- 桶：**桶2**（前置 = KODE-AUD-006 收口 + cargo job 进 CI）。估 **1.5**。
- 验收口径：`cargo test --workspace --all-targets --no-fail-fast` → `error: 1 target failed` 消失、0 failed；`.github/workflows/ci.yml` 出现 cargo test 步骤且该 PR 连绿 3 次；6 个子面各指名 ≥1 个测试文件（本文即清单）。

### QA-002 Property-based/fuzz：XML/DEF 非法输入不 panic/hang；path canonicalization 无碰撞
- 现状：**部分（确定性盲样基础版）**。
- 证据：
  - `crates/kode-parser/tests/blind.rs:1` 文件头自述「盲样抽验(QA-002 基础版)……arbitrary/proptest 纲要随 fuzz 单后置」；`:50` blind_mutations_never_panic（LCG 固定种子，截断/翻转/插入/坏实体四类变异）
  - `find crates -iname '*fuzz*'` 与 `grep proptest|arbitrary|cargo-fuzz` **0 命中** → 无 fuzz target、无性质测试依赖
  - path canonicalization 无碰撞：只有循环护栏 `crates/kode-root/src/scan.rs:277-283`（canonical 身份已见即跳过）与 `crates/kode-vfs/src/uri.rs:41` canonical URI；**无「不同输入规范化后不得碰撞」的性质测试**
- 佐证必要性：`crates/kode-server/tests/def_md5_units.rs:290` 当前栈溢出（见 §2）正是这类输入应抓的缺陷。
- 桶：**桶2**（前置 = QA-001 绿基线）。估 **3.5**。
- 验收口径：新增 proptest/cargo-fuzz target；`cargo test -p kode-parser --test blind` 与 `cargo fuzz run <target> -- -runs=100000` 0 panic/0 超时；canonicalization 性质测试 `f(a)==f(b) ⇒ a 与 b 同一路径` 的反例用例先红后绿。

### QA-003 Golden：基于真实引擎 fixtures 的 hover/definition/diagnostics/typings snapshot
- 现状：**部分**——golden 体系完整，但语料是仓内合成 fixture，非真实引擎树；typings 无 golden。
- 证据：
  - 四主请求 golden：`tests/parityGolden.test.ts:24-27`（11 请求锁 `tests/fixtures/parity/golden.json`，`KODE_PARITY_UPDATE=1` 重录）
  - Rust 侧 golden + dump bin：`crates/kode-server/src/bin/` 下 8 个 bin（dump-hover/definition/diagnostics/completion/def-md5/flag-domains/wire-golden + validate-process-topology）、`crates/kode-server/tests/{hover,definition,diagnostics,completion}_golden.rs`
  - TS↔Rust golden 对拍：`tests/kodeHoverParity.test.ts:1-27`（读 `crates/kode-server/tests/golden/hover-parity.json`），另有 `kode{Index,Types,Parser,Root,Scheduler,Completion,Definition,Diagnostics}Parity` 与 `flagDomainsParity` 共 9 个同构对拍
  - **真实引擎树**在 `tests/realEngineIntegration.test.ts:13-15`（`skipIf(!canRun)`，根经 `tests/helpers/engineRoot.ts` / `fantasyRoot.ts` 解析——`KBENGINE_ROOT` / `KODE_FANTASY_ROOT` 或同级检出回退，`VULN-KODE-R04` 移除 `:8-11` 硬编码 `/home/cui/workspaces/...`）与 `.github/workflows/engine-integration.yml:3-16`（只手动+周巡；树优先触发人给，留空自动稀疏检出两个公开 fork，周巡可真跑）
  - typings：`tests/pythonTypeStubs.test.ts`、`tests/entityTypeStubs.test.ts` 是行为单测，**无 snapshot golden**
  - 既有缺口清单：`docs/kode2/ph0-gate.md` 门 2「golden 扩面（references/rename/signature help/多根同名）、规模轴 parity、electron UI 层」三项未勾
- 桶：**桶2**（前置 = QA-001 Rust 基线绿；树本机有，可跑）。估 **3.5**。
- 验收口径：`KBENGINE_ROOT=<引擎树> KODE_FANTASY_ROOT=<fantasydemo res> npx vitest run --config vitest.integration.config.ts` 4 套件全绿**非 skip**；golden 扩面新增 ≥3 面；`KODE_PARITY_UPDATE=1` 连续两次重录 `sha256sum` 一致；`.pyi` golden 文件存在并入主门禁。

### QA-004 Differential：旧 TS 输出 vs 新 Rust 输出逐项差异审查，已知旧 bug 单独定标
- 现状：**部分，且是 17 项里底子最好的之一**——切流开关与 bench 级差分已跑通；但 provider 面只接了 4 面中的 2 面，逐项审查表与「旧 bug 定标」缺。
- 证据（切流开关已接）：
  - 配置键 `package.json:1422` `kbengine.core.backend: ts|rust|shadow`；解析 `src/kodeCoreGate.ts:44-70`（非法值回落 ts）
  - **serving 门禁**：`src/kodeCoreGate.ts:299-300` `serveFromRust(): boolean { return false; }`；`:262-264` `backend=rust` 被拒绝并 notice（唯一放行点）
  - shadow 对拍与差异日志：`src/kodeCoreGate.ts:455-500`（compare 五种 verdict）、`:141-190`（ShadowDiffLog 有界 500）
  - 装配：`src/kodeCoreGateWiring.ts:67` 差异日志通道、`:73` 配置热更新
- 证据（差分覆盖面 = 2/4）：
  - `src/kodeCoreShadowFaces.ts:187` `gate.compare('textDocument/definition', …)`；`src/languageProviders.ts:1515`、`:1598`（diagnostics）
  - **hover/completion 未接**，且被测试锁死为事实：`tests/rstServingStatusDoc.test.ts`（todo `IDE-RST-002` 明记「hover/completion shadow 接线未接」）
- 证据（已执行的差分报告）：`docs/kode2/pr-012-perf-gate.md` §1 808 采样、§4 五门 gate3 全 PASS、§5 **切流前置 4 项全未勾**、§6 后续单 5 条、§8.1 剩余差异 5 项定案表。
- 缺口：①hover/completion provider 面接线；②「逐项差异审查」没有独立落档文件；③「已知旧 bug 单独定标」**无清单**（§8.1 是设计边界定案，不是旧 bug 定标）。
- 桶：**桶1（立即可开工）**，且是阻挡最多的一项（挡 QA-005、PH7-02、切流）。估 **4.5**。
- 验收口径：①4 面接线且有测试锁；②`TMPDIR=/tmp KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/shadowGate.bench.ts`（先 `cargo build -p kode-server --release`）五门复跑 PASS；③`docs/kode2/qa-004-diff-review.md` 逐条差异三分类 `[TS 旧 bug | Rust 新差 | 设计边界]`，每条带复现命令。

### QA-005 Integration：VS Code Extension Host + native server e2e，对比用户可见结果
- 现状：**部分**——Extension Host e2e 底子很厚，但**全部跑在 TS 单轨，没有 native server 参与**；且不在 CI。
- 证据：
  - 真机层入口 `src/test/electron/runTest.ts:1-10`（`@vscode/test-electron`），套件 16 个 `src/test/electron/suite/*.test.ts`（field/demo/vsix/multiroot/storm/delfile/rename/dirty/longsession/attribution/final…）
  - `src/test/suite/` 只有 4 个文件（activationSmoke/manifest/providerSmoke/testUtils），`src/test/runTest.ts:1-33` 是**纯 node mocha 烟测**（不下载 VS Code，见 `TESTING.md` 层次表）
  - `pnpm test` = vitest + tsc + mocha 烟测（`package.json#scripts.test`）；electron 走独立命令 `test:electron` / `test:smoke:vsix` / `test:demo:field`
  - native server e2e 存在但是 headless：`tests/kodeCoreE2E.test.ts:13-17`（真实 `target/debug/kode-server`，握手→镜像→cancel→kill 重启）
  - 缺口：`grep 'backend|shadow|serverPath' src/test/electron/` **0 命中**；`grep xvfb .github/workflows` **0 命中** → 无「Extension Host + native server」组合，electron 也从不进 CI
- 桶：**桶2**（前置 = QA-004 的 hover/completion shadow 接线；CI 部分前置 = 批 0 runner 改造）。估 **3.5**。
- 验收口径：新增 `--shadow` electron 模式 + 套件，断言用户可见结果（hover/definition/diagnostics 三面）与 ShadowDiffLog verdict 双绿；`pnpm test:electron -- --shadow` RC=0；接 CI（xvfb）后该 job 连绿 3 次。

### QA-006 Python LS 互操作：Pylance / Pyright、不同 Python 环境、.pyi 优先级
- 现状：**部分（现场验收已有，自动化矩阵缺）**。
- 证据：
  - 四面对照现场报告 `docs/perf/2026-10-28-p0-4c-joint-acceptance.md`（Pylance 2026.4.1 + Python 2026.10.0）
  - 归因真机套件 `src/test/electron/suite/serviceAttribution.test.ts`（todo `IDE-ACC-008` [x]）
  - 状态面 `src/pythonLanguageServiceStatus.ts` + `tests/pythonServiceStatus.test.ts`
  - `.pyi` 优先级：`src/pythonStubExport.ts:73`（`kbengine.python.stubDir` / `KBENGINE_STUB_DIR` 优先）、`tests/managedDir.test.ts:82`
  - 缺口：Pylance/Pyright **双实现矩阵**、多 Python 环境矩阵无可复跑套件
- 桶：**桶1**（本机已有 `.vscode-test/extensions` 装好的 Pylance；多版本扩展需网络）。估 **2.5**。
- 验收口径：`KODE_FIELD_OUT=/tmp/acc8 pnpm test:electron -- --attribution` RC=0 + 新矩阵用例（Pylance 缺席 / Pyright 在场 / 无 LS 三态）全绿，`.pyi` 优先级矩阵（stubDir > managedDir > 默认约定）断言在 `tests/managedDir.test.ts` 系列补全。

### QA-007 Workspace 兼容：Windows path / Linux case / macOS case-insensitive / WSL / SSH / containers
- 现状：**部分（单测层有，真实执行层 0）** → 需外部条件，全矩阵 3–4 周内不可能。
- 证据：
  - `crates/kode-root/tests/discovery.rs:324`（root002_platform_case_folding_matrix）、`:342`（root002_wsl_unc_semantics）；`crates/kode-root/src/platform.rs:36` `cfg!(target_os = "windows")`
  - TS 侧 win32 分支：`tests/workspacePath.test.ts`、`tests/debugConfig.test.ts` 等 10 个文件
  - **CI 单平台**：`ci.yml` `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`，`grep 'matrix.*os|windows-latest|macos-latest' .github/workflows` **0 命中**
  - todo `IDE-ACC-010` 明列「跨平台面未复现」为保留开放项
- 桶：**桶3（需外部条件 = 多平台 runner）**。估（降级范围）**2.0**；全量不可行。
- 验收（降级）口径：ci.yml 增 `matrix.os: [ubuntu-latest, windows-latest, macos-latest]` 的 cargo+vitest job，三平台连绿 3 次；WSL/SSH/containers **显式标 0.3 推迟**，不进 v0.2.0 判定。

### QA-008 Engine 兼容：官方支持版本 + 用户 fork；profile 未知降级
- 现状：**部分（单版本树联验有，矩阵无）** → 需外部条件。
- 证据：
  - `.github/workflows/engine-integration.yml:3-16`（只 `workflow_dispatch` + 周巡；树优先触发人给、留空自动稀疏检出 fork 所需子路径，通用 runner 也能真跑）、`:109` `vitest run --config vitest.integration.config.ts`
  - `vitest.integration.config.ts:22-26` 显式清单 4 文件（engineTreeProbe/realEngineIntegration/fantasydemoRealExport/fantasydemoDefAnalysis），每文件自带树守卫
  - 本机树：`tests/helpers/engineRoot.ts`（`KBENGINE_ROOT` 或 `../kbengine`）与 `tests/helpers/fantasyRoot.ts`（`KODE_FANTASY_ROOT` 或 `../BigWorld/programming/fantasydemo/res`，`VULN-KODE-R04`）；todo `IDE-LIV-002` 实核 `/home/cui/workspaces/kbengine@f85ad81`
  - todo `IDE-LIV-003` [P2] **阻塞：缺可启动引擎实例**（`kbe/bin` 仅 Windows dll）
- 桶：**桶3（需外部条件 = 多版本引擎检出/编译）**。估（降级范围）**1.75**；版本/fork 矩阵不可行。
- 验收（降级）口径：`KBENGINE_ROOT=<树> npx vitest run --config vitest.integration.config.ts` 4 套件全绿非 skip；补「profile 未知 → 降级不崩」单测；**官方多版本 + 用户 fork 矩阵推迟 0.3**。

### QA-009 Security：workspace trust、命令注入、路径穿越、生成文件覆盖、恶意插件、日志敏感数据
- 现状：**部分（四面有底子，两面完全缺失，一面不可能）**。
- 证据：
  - 生成文件覆盖保护：todo `IDE-GEN-001..008` 全 [x]（`todo.md:403-414`），`tests/codeGeneratorFiles.test.ts`、`tests/generatorAtomicWrite` 系
  - 日志/导出敏感遮蔽：todo `IDE-REL-007` [x]，`src/reproductionSummary.ts`（`maskConnectionSecrets` 两层遮蔽）
  - 命令/语句注入（白名单面）：todo `IDE-DB-002` [x]，`src/databaseTablePreview.ts` 表名正则 + `assertReadOnlyStatement`
  - **workspace trust：完全缺失** —— `package.json` 无 `capabilities` 声明（grep 0 命中）、`src/**` 无 `isTrusted/workspaceTrust`（0 命中）
  - **路径穿越专项：无**（`grep 'path traversal|路径穿越' src tests crates` 0 命中）
  - **恶意插件：不可能** —— 插件系统 §12 `PLUG-001..016` 未落地（`crates/README.md` 表中无插件 crate）
- 桶：**桶1（降级范围：trust + 穿越 + 注入 + 日志四面）**。估 **3.5**。
- 验收口径：新增 `tests/security*.test.ts`，判据=①非受信工作区不执行写盘/子进程；②`../` 与绝对路径逃逸被拒（生成落点、stub 导出、日志读取三处）；③注入面单测（表名/telnet 命令/quick action 脚本）；④日志与导出负向正则无凭据。**恶意插件面推迟 0.3**（插件系统落地后随 §12 验收）。

### QA-010 Resilience：Core kill、client disconnect、损坏缓存、watcher flood、磁盘满、权限拒绝
- 现状：**部分（约 3/6 面有）**。
- 证据：
  - Core kill + 自动重启：`tests/kodeCoreE2E.test.ts`（E 组真实进程 kill 后自动重启）、`src/kodeCoreClient.ts:397` restartGeneration
  - 权限拒绝/磁盘满（单元层）：`tests/hotReloadTempEdit.test.ts:171`（EACCES）`:181`（ENOSPC）、`tests/cov-entity-schema.test.ts:253/289/798`（EACCES/disk full/chmod 000）、`tests/serverManagerRunner.test.ts:229`
  - watcher flood：**无专项**；150 轮 didChange 只在 `tests/perf/shadowGate.bench.ts`（bench 不进门禁，`vitest.bench.config.ts:7-8`）
  - client disconnect、损坏索引缓存重建：**无专项**（`grep corrupt|损坏 tests` 只命中 buildCommit/registry 类）
- 桶：**桶1**。估 **3.25**。
- 验收口径：新增 `tests/resilience*.test.ts` 覆盖 6 面，判据=注入后 `pendingWork()` 四面归零 + 服务继续应答 + 缓存损坏后可重建且不静默改用户文件。

### QA-011 Memory & race：1h 编辑负载、循环增删根、索引与 diagnostics 并发、高频 restart
- 现状：**部分（长会话 12 轮已有，1h 无）**。
- 证据：
  - 长会话真机：`src/test/electron/suite/longSessionResources.test.ts`（todo `IDE-ACC-009`/`IDE-REV-034` [x]，暖机 2 轮 + 正式 10 轮、RSS 分面预算、worker 字节量规）
  - 并发竞态：`tests/documentStore.test.ts:211`（同版本只解析一次/旧结果不覆盖）、`src/test/electron/suite/stormRecovery.test.ts`（输入风暴后无过期诊断）
  - **1h 编辑负载：0 命中**（`grep '1h|soak|一小时' tests src crates` 空）；高频 restart 只有单次 kill 重启
- 桶：**桶1**（需 1h 无干扰机时，本机 xvfb 可跑）。估 **2.75**。
- 验收口径：新增 `--soak1h` electron 模式（或等价脚本），判据=1h 内 RSS 稳态漂移 ≤ 预算（沿用 REV-034 分面口径）、队列逐段归零、循环增删根 50 轮无增长、高频 restart 20 次每次握手成功；若拿不到机时，**降级**为 10 分钟 soak + 既有 12 轮长会话并标注。

### QA-012 Protocol compatibility：旧客户端/新 Core、新客户端/旧 Core 均有正确握手/错误
- 现状：**部分（版本常量有，校验与矩阵无）**。
- 证据：
  - `crates/kode-protocol/src/lib.rs:15` `PROTOCOL_VERSION: &str = "0.2.0"`；`:14` 注释自述「不匹配由 TS 侧提示（BUILD-015 后续 PR）」= 该 PR 未做
  - `crates/kode-server/src/server.rs:273`、`:622` serverInfo 回传
  - `src/kodeCoreClient.ts:156` `initialize()` 只取结果，**不校验 name/version**
  - 测试只有「当前版本相等」：`tests/kodeCoreE2E.test.ts:75-76`；**无旧/新交叉矩阵**
- 桶：**桶1**。估 **2.25**。
- 验收口径：握手版本不匹配 → 返回可读错误 + kill-switch 回落 TS（非法/不匹配值不得静默服务）；矩阵测试 4 组（旧 client×新 core、新 client×旧 core、名字不符、版本不符）绿。

### QA-013 性能发布门槛：同时检测 P95、P99、max、CPU、RAM、index correctness
- 现状：**部分（bench 生态齐，CI 门槛 0）**。
- 证据：
  - 10 个 bench：`tests/perf/{baseline,coldHover,defPerf,discoverySync,documentStore,gate,providerHotspots,shadowGate,timerDelay,unblockedDefinition}.bench.ts`
  - 分位与内存已有实测：`docs/perf/2026-gate-baseline.md` §2（P50/P95/P99/max + 5 轮中位）、§4（RSS 25ms 采样）
  - **不进门禁**：`vitest.bench.config.ts:7-8`「不参与 pnpm test / vitest run 等门禁」
  - **CPU/RAM CI 阈值、index correctness 门槛：无**；`docs/perf/2026-gate-baseline.md` §6 记 PERF-010..014「未动，仍开放」
  - 噪声约束：同代码 3 轮墙钟极差 39.6s（机械盘）、`PERF-015` 禁跨机比
- 桶：**桶2**（前置 = 固定基准机 + runner 稳定；阈值定义部分可与桶 1 并行）。估 **3.5**。
- 验收（降级）口径：`docs/kode2/perf-thresholds.yaml` 定阈值（P95/P99/max/RSS/index correctness 五类）+ 本地固定机 `npx vitest run --config vitest.bench.config.ts tests/perf/gate.bench.ts` 输出 PASS/FAIL；**CI 只挂 index correctness + 粗阈值**，硬性能阈值标注「基准机执行、存档报告」。

### QA-014 生成覆盖率达到门槛前不得标「所有 Python 文件类型完整生成」
- 现状：**缺失（门槛与量测都没有）；好消息是文案未越界**。
- 证据：`grep '所有 Python 文件类型完整生成'` **只命中 `docs/kode2/KODE_2_COMPLETE_TODO.md:361`**（即任务书本身），README/docs/CHANGELOG/src 无此宣称 → 无现存越界。
  - pyi 生成面：`src/pythonTypeStubs.ts`、`src/entityTypeStubs.ts`，todo「pyi 存根修复与增强」段 5 项全 [x]（`todo.md:166-172`）
  - **无「Python 文件类型生成覆盖率」量测**
- 桶：**桶1**。估 **1.5**。
- 验收口径：`scripts/measure-pyi-coverage.mjs`（按文件类型/构造面统计生成成功率）+ 门槛值 + 文案审计测试（README/docs 若出现该短语必须同句带覆盖率数字）。

### QA-015 每个修复 PR 附复现脚本、测试证据、profile/perf delta、回退计划
- 现状：**缺失（无 PR 模板）**。
- 证据：`.github/` 下**只有 `workflows/`**（`ls -a .github`）；`CONTRIBUTING.md:184-220` 有 PR 标题/描述模板与审查清单，但**无复现脚本、perf delta、回退计划字段**。仓内实际口径在 `todo.md` 勾账约定（commit+file:line+测试数），未进 PR 模板。
- 桶：**桶1（建议第一项做，影响后续所有 PR 口径）**。估 **0.5**。
- 验收口径：新增 `.github/PULL_REQUEST_TEMPLATE.md` 四字段 + 守卫测试（`docsCommands` 同款）锁字段齐全；首个按模板走的 PR 可查。

### QA-016 大型功能启用 feature flag，parity/perf 完成后再移除旧实现
- 现状：**部分（大功能开关已有，移除旧实现的闸只有文档）**。
- 证据：
  - 大功能开关 = `kbengine.core.backend`（`package.json:1422`），`serveFromRust()` 恒 false（`src/kodeCoreGate.ts:299-300`）即「未完成 parity 前不移除旧实现」的机械保证
  - 其余 44 个 `kbengine.*` bool（`IDE-REL-007` 自动枚举）
  - 移除条件只在文档：`docs/kode2/ph0-gate.md` 门 3 🟡、`KODE_2_COMPLETE_TODO` PH7-02
  - **无 flag 台账、无「移除旧实现」自动闸**
- 桶：**桶1**。估 **1.25**。
- 验收口径：`docs/kode2/feature-flags.md` 台账（flag / 保护的旧实现 / 移除条件 / 当前状态）+ 测试锁（非法 backend 回落 ts 已有 `tests/kodeCoreGate.test.ts`，扩到「台账里每个大功能 flag 都有开关测试」）。

### QA-017 自动发布必须遵循现有仓库的手动发布规则
- 现状：**基本已有，需固化为可检查的规则**。
- 证据：
  - `publish.yml:3-16` 只 `workflow_dispatch`；`:37-53` publisher 与版本号逐字一致性闸（不一致直接 `exit 1`）
  - `ci.yml:119` 注释「Marketplace 发布只有一条正道:publish.yml workflow_dispatch」；D-3 季度复核已拆掉两条绕闸腿（`todo.md` D-3 [x]）
  - `nightly.yml:125` 只滚 `nightly` tag，不发 Marketplace
  - 发布前检查清单：`docs/zh/guide/development.md:102`
- 桶：**桶1**。估 **0.75**。
- 验收口径：守卫测试锁三件事——`ci.yml`/`nightly.yml` 无 `vsce publish` 步骤、`publish.yml` 必含 `workflow_dispatch` + 版本闸、发布清单页存在且含 7 条检查。

---

## 2. 评估期实跑基线（真实执行，非引用文档）

| 命令 | 结果 |
|---|---|
| `cargo test --workspace --all-targets --no-fail-fast` | 76 个测试二进制、**441 passed**；**1 个目标失败**：`crates/kode-server/tests/def_md5_units` 中 `parent_cycle_does_not_overflow`（`def_md5_units.rs:290`）**栈溢出 SIGABRT** |
| `pnpm test:unit` | **5664 passed / 1 failed / 7 skipped**（460 文件，79s）。失败用例 `tests/fantasydemoRealExport.test.ts:85`（`:19` 硬编码 fantasydemo 路径、`:30` `describe.skipIf` 在本机有树时不跳过 → 本机红 / CI 绿的分叉） |

两条红的定性：
1. `def_md5_units` 红 = **在制品**：`git diff` 显示 `crates/kode-server/src/def_md5.rs` +8 行、`def_md5_units.rs` +60 行是未提交 WIP，对应 todo **`KODE-AUD-006 [P1]`（`todo.md:975`，未勾）**——interface 环已修，parent 环测试仍溢出。**HEAD 上没有该测试**（`git show HEAD:… | grep -c parent_cycle` = 0），所以是「新测试先红」的正常 TDD 中间态，但必须收口。
2. `fantasydemoRealExport` 红 = **本机环境依赖**，CI 无该路径会 skip；v0.2.0 签收前必须给出「本机红」的处置（修或显式降级为 integration-only）。

CI 现状（`grep -rn cargo .github/workflows` = 0 命中）：
- `ci.yml:84-86` 只跑 `pnpm exec vitest run --coverage` + lint + package；**无 cargo、无 electron/xvfb**
- `nightly.yml:84-85` `pnpm test`（vitest + mocha 烟测），同样无 cargo
- 工作树里 `.github/workflows/ci.yml` 已加 `concurrency`（防 runner 排队，未提交）——批 0 的第一件事就是把它落 commit 并验证

---

## 3. 与 `todo.md` 150 未完成项的关系（只交叉引用，不复制）

原则：**本文档不把 17 项抄进 todo.md**，避免双口径；勾账仍以 `KODE_2_COMPLETE_TODO.md` §14 为准，todo.md 只在对应既有条目完成时被顺带满足。

| QA | 会被既有 P1/P0 项顺带满足的部分 | 对应 todo 条目 ID |
|---|---|---|
| QA-001 | Rust 递归保护（当前红）→ parser/md5 面单测可签收 | `KODE-AUD-006 [P1]`（todo.md:975） |
| QA-002 | 非法输入不 panic 的一类真缺陷 | 同上 `KODE-AUD-006`；fuzz 基座本身 todo 无对应项（**需新增，本文建议只在 QA 侧建，不进 todo**） |
| QA-003 | 同输入对拍测试（配置域） | `KODE-CFG-002 [P1]`、`KODE-CFG-003 [P1]`（todo.md:1006-1007）；既有 R2 五张 parity golden（todo.md:199 已勾） |
| QA-004 | 逐面 shadow 覆盖记录、切流门现状 | `IDE-RST-002 [P2]`（已勾，锁「hover/completion 未接」）；`KODE-CFG-002/003` 的对拍即差分输入 |
| QA-005 | 真机逐场景验收族（Extension Host 层） | `IDE-ACC-001..013`（其中 **`IDE-ACC-007`、`IDE-ACC-010` 仍开放**）、`IDE-REL-006 [P1]`（vsix 烟测，已勾） |
| QA-006 | 与 Python LS 共同启用的归因验收 | `IDE-ACC-008 [P1]`（已勾）；`PY-ENV` 相关开放项 |
| QA-007 | 真机验收里「跨平台面未复现」已如实留账 | `IDE-ACC-010 [P1]` 保留开放六条之一 |
| QA-008 | 真实引擎联验输入登记与协议号实核 | `IDE-LIV-001/002`（已勾）、**`IDE-LIV-003 [P2]` 阻塞中**（缺可启动引擎实例） |
| QA-009 | 生成覆盖保护、敏感遮蔽、语句白名单 | `IDE-GEN-001..008 [P1]`（全已勾）、`IDE-REL-007 [P1]`（已勾）、`IDE-DB-002 [P2]`（已勾）；**workspace trust 无对应项** |
| QA-010 | 队列/缓存/字节上限等资源边界 | `IDE-RES-001..008 [P2]`（全已勾）、`IDE-AUD-022 [P0]`（已勾）；**client disconnect / watcher flood 无对应项** |
| QA-011 | 长会话资源预算与量规 | `IDE-ACC-009` / `IDE-REV-034 [P1]`（已勾）；**1h soak 无对应项** |
| QA-012 | 协议源码取证（会给出版本/兼容依据） | `PA-001 [P1]`（todo.md:928，开放）；`IDE-AUD-007 [P1]`（真实协议证据，开放） |
| QA-013 | 双指标分判的验收口径 | `IDE-ACC-010 [P1]`（hover P95≤30 / definition P95≤50 分判）；`PERF-010/011`（KODE_2 §1，未动） |
| QA-014 | pyi 生成正确性修复已闭环 | 「pyi 存根修复与增强」段 5 项（todo.md:166-172，全 [x]）；**覆盖率门槛无对应项** |
| QA-015 | PR 证据口径的事实标准 | `todo.md` 头部勾账约定（commit+测试数+file:line）；`CONTRIBUTING.md:214` 审查清单 |
| QA-016 | 大功能开关与「不删旧实现」的机械闸 | `IDE-RST-002`（切流门三面）、`ph0-gate.md` 门 3、KODE_2 `PH7-02` |
| QA-017 | 手动发布唯一正道已拆除两条绕闸腿 | `D-3 [x]`（todo.md:186）；`IDE-REL-001..007 [P1]` 发布与共存族 |

> 写入约定：上述 todo 条目**已在 todo.md 中**，本文只引用 ID；若某 QA 项需要新增 todo 条目（如 fuzz 基座、workspace trust、1h soak、覆盖率门槛），**建议在 §14 下以 QA 编号勾账，不另开 todo 行**，以免两本账。

---

## 4. 三桶与排序

### 桶 1 — 立即可开工（无前置），按「阻挡其他项最多者优先」

| 序 | 项 | 估(人日) | 为什么排这里 |
|---|---|---|---|
| 1 | QA-015 | 0.5 | PR 模板影响后续每一批的交付口径，先立规矩 |
| 2 | QA-004 | 4.5 | 挡 QA-005、PH7-02、切流；底子最好，边际成本最低 |
| 3 | QA-017 | 0.75 | 发布守卫，挡发版判定 |
| 4 | QA-016 | 1.25 | flag 台账，QA-004 的切流与 PH7-02 都要引用它 |
| 5 | QA-012 | 2.25 | 握手版本校验，QA-005 e2e 稳定与切流都依赖 |
| 6 | QA-014 | 1.5 | 文案门槛，发布前必须有，工作量小 |
| 7 | QA-009 | 3.5 | 安全四面，发布阻断项 |
| 8 | QA-010 | 3.25 | 韧性六面，发布阻断项 |
| 9 | QA-011 | 2.75 | 1h soak 需排队占机时，早启动早占机 |
| 10 | QA-006 | 2.5 | 互操作矩阵，可与上面并行 |
| — | QA-013（阈值定义部分） | (1.0) | 可与桶 1 并行做，CI 挂钩归桶 2 |

小计 ≈ **22.75 人日**（含 QA-013 定义部分）。

### 桶 2 — 需先完成某项

| 序 | 项 | 估(人日) | 前置 |
|---|---|---|---|
| 1 | QA-001 | 1.5 | `KODE-AUD-006` 收口 + cargo job 进 CI（批 0） |
| 2 | QA-002 | 3.5 | QA-001 绿基线（fuzz 要能在 CI 跑） |
| 3 | QA-003 | 3.5 | QA-001 绿基线 + golden 扩面 |
| 4 | QA-005 | 3.5 | QA-004 的 hover/completion shadow 接线 + CI xvfb |
| 5 | QA-013（CI 挂钩部分） | 2.5 | 固定基准机 / runner 稳定 |

小计 ≈ **14.5 人日**。

### 桶 3 — 需外部条件

| 项 | 估(人日) | 外部条件 |
|---|---|---|
| QA-007（降级范围） | 2.0 | Windows/macOS runner（GitHub-hosted 或自建）；WSL/SSH/containers 需真实机器 |
| QA-008（降级范围） | 1.75 | 多版本引擎检出/编译、可启动引擎实例（`IDE-LIV-003` 同款阻塞） |

小计 ≈ **3.75 人日**。

**总计 ≈ 41 人日**（区间 40–45，取中值）。

---

## 5. 3–4 周分批建议

> 批次是**串行门**：上一批判据全绿才开下一批；批内各项可并行（双人时按序号分工）。

### 批 0（D1–D3）：CI 与 runner 排队 + QA-001
- 内容：落 commit 工作树里的 `ci.yml concurrency`；新增 cargo test/clippy job；收口 `KODE-AUD-006`（parent 环）；处置 `fantasydemoRealExport` 本机红；冻结基线数字。
- 依赖：无（这是所有后续批次的地基）。
- **完成判据**：①`cargo test --workspace --all-targets --no-fail-fast` 0 failed；②`pnpm test:unit` 0 failed（或 fantasydemo 显式降级为 integration-only 并写明）；③新 ci.yml 在连续 3 个 PR 上全绿；④`KODE_2_COMPLETE_TODO` §14 QA-001 带 commit+命令+证据勾选。

### 批 1（W1）：QA-015 → QA-004 → QA-017 → QA-016 → QA-012 → QA-014（6 项）
- 依赖：批 0。QA-004 内部顺序=先接 hover/completion shadow → 复跑 shadowGate bench → 落差异审查表。
- **完成判据**：6 项各自 §1 的验收命令全绿；`docs/kode2/qa-004-diff-review.md`、`docs/kode2/feature-flags.md`、`.github/PULL_REQUEST_TEMPLATE.md` 三份产物落档。

### 批 2（W2）：QA-009 → QA-010 → QA-011 → QA-002（4 项）
- 依赖：批 1（QA-002 依赖批 0 的绿基线；QA-011 的 1h 机时在本周占用）。
- **完成判据**：`tests/security*.test.ts`、`tests/resilience*.test.ts`、`--soak1h` 套件、fuzz/property target 四组全绿；1h soak 报告落 `docs/perf/`。

### 批 3（W3）：QA-003 → QA-005 → QA-013（3 项）
- 依赖：批 1（QA-004 接线是 QA-005 的前置）、批 0（CI xvfb）。
- **完成判据**：integration 4 套件非 skip 全绿；`pnpm test:electron -- --shadow` RC=0 且接进 CI；`perf-thresholds.yaml` + 固定机 gate bench PASS。

### 批 4（W4）：QA-006 → QA-007（降级）→ QA-008（降级）+ 全量复跑 + 签收
- 依赖：前三批全绿；QA-007/008 只交付降级范围。
- **完成判据**：17 项全部带证据勾选；全量门禁（`pnpm test` + `cargo test --workspace --all-targets` + lint + docs build）连续 3 次绿；PH7-01 的 **48h 真实项目试用**启动（可与本周并行，日历 2 天）；4 项降级在 §14 逐条标注「降级签收 + 0.3 待办」。

**人力口径**：约 41 人日 → **2 人 × 4 周（≈40 人日）刚好覆盖**；**1 人 × 4 周 ≈ 20 人日，只能完成批 0 + 批 1 + 批 2 的前三项（约 10 项）**，见 §7。

---

## 6. 诚实标注：3–4 周内根本不可能全量完成的项（及降级建议）

| 项 | 为什么不可能 | 降级建议 |
|---|---|---|
| **QA-007 全矩阵**（Windows path / macOS case-insensitive / WSL / SSH / containers 真实执行） | 仓内只有单 `runs-on`，无任何多平台 job；WSL/SSH/容器需要真实机器或额外 runner，4 周内排不进 | **缩范围**：CI 加 `windows-latest`/`macos-latest` 两平台 job（cargo+vitest），真实执行面签收这两平台；WSL/SSH/containers **推迟 0.3** 并在 §14 写明 |
| **QA-008 官方版本 + 用户 fork 矩阵** | 需多版本引擎检出/编译与可启动实例；`IDE-LIV-003` 已因「无 Linux 编译产物」阻塞 | **缩范围**：单版本树（本机 `kbengine@f85ad81`）联验 4 套件 + profile 未知降级单测；**多版本/fork 矩阵推迟 0.3** |
| **QA-009「恶意插件」面** | 插件系统（§12 `PLUG-001..016`）未落地，无插件宿主可测 | **缩范围**：v0.2.0 安全验收只覆盖 trust/路径穿越/命令注入/日志四面；**插件沙箱随插件系统在 0.3+ 验收** |
| **QA-013 CI 硬性能阈值（P95/P99/max/CPU/RAM）** | 需固定基准机；当前 runner 排队、机械盘单轮极差 39.6s、`PERF-015` 禁跨机比 → CI 上的硬阈值会是假红/假绿 | **缩范围**：CI 挂 index correctness + 粗阈值；硬性能阈值**本地固定机执行并存档报告**，作为发布签收附件而非 CI 门 |
| **QA-011 的 1h 真实编辑负载**（边界情况） | 可行，但需 1h 无干扰机时；拿不到就做不了 | 若机时不到位：**降级**为 10 分钟 soak + 既有 12 轮长会话，并在 §14 标注「1h 未做」——不许用 12 轮冒充 1h |
| **QA-005 的「CI 里跑 Extension Host e2e」**（边界情况） | 需 xvfb + 在 runner 上下载 VS Code（网络/机时） | 若 runner 不支持：**降级**为本地执行 + 证据入 `docs/perf/`，CI 只保 headless `kodeCoreE2E` |

> 除上表外，其余 11 项按降级范围在 3–4 周内**是可完成的**，未发现第三类「无论如何都做不完」的项。

---

## 7. 单人 4 周能交付到哪（避免虚估）

- 可完成（约 10 项）：**QA-001、QA-015、QA-017、QA-016、QA-014、QA-012、QA-004、QA-009、QA-010、QA-011**（= 批 0 + 批 1 + 批 2 前三项）。
- 只能部分完成/推迟（7 项）：**QA-002、QA-003、QA-005、QA-013、QA-006、QA-007、QA-008**。
- 结论：**「17 项全部完成再发 v0.2.0，1 人 3–4 周」不成立**；要么 2 人满负荷 4 周，要么把发版判定句改成「11 项 + 6 项降级签收」（见 §8 的可选缩写版）。

---

## 8. 「什么条件满足即可发 v0.2.0」——单一判定句

> **当且仅当：(a) `docs/kode2/KODE_2_COMPLETE_TODO.md` 第 14 节 QA-001~017 十七个复选框全部按本文 §1 的验收命令跑绿并带 `commit + 命令 + 证据文件` 勾选（QA-007/008/009/013 四项按 §6 降级范围签收并逐条标注 0.3 待办），且 (b) `cargo test --workspace --all-targets --no-fail-fast` 与 `pnpm test` 在 CI 上连续 3 次全绿，且 (c) PH7-01 的 48h 真实项目试用期间无 P0 缺陷——才推 v0.2.0 tag 并走 `publish.yml` 的 `workflow_dispatch` 手动发布。**

（单人 4 周的缩写版：把 (a) 中的 17 项替换为「§7 列出的 10 项绿 + 其余 7 项在 §14 标注为『降级/推迟 0.3』并由用户逐条签收」，其余 (b)(c) 不变。）

---

## 附：本文档引用的关键 file:line 索引

- 切流门：`package.json:1422`、`src/kodeCoreGate.ts:44-70 / :262-264 / :299-300 / :455-500`
- shadow 接线面：`src/kodeCoreShadowFaces.ts:187`、`src/languageProviders.ts:1515 / :1598`、`src/kodeCoreGateWiring.ts:67 / :73`
- CI/工作流：`.github/workflows/ci.yml:84-86 / :119`、`nightly.yml:84-85 / :125`、`publish.yml:3-16 / :37-53`、`engine-integration.yml:3-16 / :109`
- 测试分层：`vitest.config.ts:16`、`vitest.bench.config.ts:7-8`、`vitest.integration.config.ts:22-26`、`src/test/runTest.ts:1-33`、`src/test/electron/runTest.ts:1-10`、`tests/kodeCoreE2E.test.ts:13-17`
- Rust 测试：`crates/kode-parser/tests/blind.rs:1 / :50`、`parser_units.rs:11 / :127 / :318`、`crates/kode-vfs/tests/coordinates.rs:129-192`、`crates/kode-types/tests/types_units.rs:95`、`crates/kode-index/tests/index_units.rs:171`、`crates/kode-server/tests/def_md5_units.rs:290`
- 差分/性能报告：`docs/kode2/pr-012-perf-gate.md §1-§6、§8.1`、`docs/kode2/ph0-gate.md` 三门状态、`docs/perf/2026-gate-baseline.md §2/§4/§6`
- 当前两条红：`tests/fantasydemoRealExport.test.ts:19 / :30 / :85`、`todo.md:975`（`KODE-AUD-006`）

> **更新（2026-11-03）**：QA-013 的「固定基准机」缺口已解决——用户将启用一台 2 路 64 核服务器加入舰队，指定为性能基线专用机（QA-011 浸泡与 QA-013 基准均在此执行，不在开发机上跑，消除负载数值漂移）。启用后本计划 §6 的 QA-013 降级条款（本地固定机）自动升级为该机的正式基准。
