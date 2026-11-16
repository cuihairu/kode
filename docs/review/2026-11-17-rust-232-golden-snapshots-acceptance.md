# RUST-232 验收纪要:真实引擎 fixtures 的 golden snapshot(hover/definition/diagnostics/typings)(纯对账)

日期:2026-11-17。本纪要对账 RUST-232(旧 QA-003,主 todo 排队项)的验收口径与交付证据。结论:**四维全部既有面——17 个 golden 对拍测试+18 个金标 JSON(Rust 侧 dump 真值,TS 侧 parity 套件复算同 goldens 双向对拍),语料=tests/fixtures/kbengine-demo-assets 真引擎夹具;typings 维由语义金标 stub probe+桩包模板物理在仓+生成面内容锚三层承载。零代码缺口,纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 金标文件 | Rust 真值测试 | TS 双向对拍 |
| --- | --- | --- | --- |
| hover | `crates/kode-server/tests/golden/hover-parity.json` | `tests/hover_golden.rs`(重生成逐字节比对,差异报偏移+再生成命令,禁止静默吞差异) | `tests/kodeHoverParity.test.ts`(不改 src/,用现有实现复算同一 golden) |
| definition | `golden/definition-parity.json` | `tests/definition_golden.rs` | `tests/kodeDefinitionParity.test.ts` |
| diagnostics | `golden/diagnostics-parity.json`+`golden/diagnostic-pipeline-parity.json` | `tests/diagnostics_golden.rs`+`tests/diagnostic_pipeline_golden.rs` | `tests/kodeDiagnosticsParity.test.ts`+`tests/kodeDiagnosticPipelineParity.test.ts` |
| typings | ①`golden/semantics-facts.json` 含 `.kbengine/stubs/KBEngine.pyi` probe 面(`generated-stub` probe/owner 断言,真引擎语料全量重放,semantics_golden.rs 逐字节对拍);②kbe API 桩包 `typings/` 物理在仓(fork 钉点 28d2117+再生成说明防手改漂移,清单测试钉);③自建类型桩生成面内容锚(`tests/entityTypeStubs.test.ts`/`tests/pythonTypeStubs.test.ts` 逐关键行:class Avatar(Entity):/源行回链 .def→types.xml/TypedDict/内置注解表注册面锁) | `tests/semantic_golden.rs`(RUST-116 分类账纪律:差异必须人工审查,不得静默再生成) | 桩包清单/生成锚 8 套件在册 |

- 语料真实性:hover/definition/diagnostics parity 套件头注与常量钉 `tests/fixtures/kbengine-demo-assets`(KBEngine 官方 demo 工程夹具)。
- 金标面全景:18 个 parity JSON(code-action/completion/def-md5/def-param-hints/def-props/def-rename/definition/diagnostics×2/document-symbols/flag-domains/hover/python-call-at/python-method-calls/references/semantic-tokens/wire/semantics-facts),17 个 `*_golden.rs` 对拍测试在册。

## 自我验收证据

- `npx vitest run kodeHoverParity/kodeDefinitionParity/kodeDiagnosticsParity/kodeCompletionParity` RC=0(14 例);全量 unit 10659(2113d5f4 门禁)含全部 parity 套件绿。
- Rust 侧 golden 测试当日 CI nightly 全链覆盖;kode-server 树现有并发会话在途件,本地不编译该 crate 脏树(净检出才是真口径纪律),Rust 真值比对以在册测试+CI 链为证。

## 诚实条款

- **自建类型桩无独立全量字节级 golden**:生成面是 fixture 驱动内容锚钉(关键行断言,非全文件逐字节);再生触发面由 `tests/entityStubRegen.test.ts` 时序钉覆盖。全量 stub golden 属可补强项非缺口——生成内容已三层锚定(模板物理在仓/生成锚/语义金标 probe)。
- 金标防漂移机制是「差异先入分类账人工审查,不得静默再生成」(RUST-116 判例),不是「golden 永不变」——如实记账。
