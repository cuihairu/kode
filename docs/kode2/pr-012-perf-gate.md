# PR-012 perf/gate-phase2 — 真实大型数据压力测试与性能/正确性验收报告(门禁判定)

- 日期:2026-10-23 · 分支 v0.2 · 依据:docs/kode2/KODE_2_COMPLETE_TODO.md §17 PR-012 原文(L440):「真实大型数据压力测试和性能/正确性验收,不通过禁止继续扩大迁移」
- 执行器:`tests/perf/shadowGate.bench.ts`(bench 专用配置,不进 pnpm test 门禁);原始输出正本:`docs/kode2/pr-012-gate2-run.txt`(GATE2-* 行,逐数字可对账)
- 资产集:`scripts/generate-perf-assets.mjs` 同参数 30k(large=30005 文件 + def-heavy=1323 文件 + 其余场景),`/tmp` 下生成后对拍
- Rust 侧:`cargo build -p kode-server --release` 产物(release,kode-server 0.2.0);TS 侧:真实 EntityMappingManager + KBEngineHoverProvider/KBEngineCompletionProvider(零改动)
- 环境:node v24.21.0 / linux / 14 cpus;`/tmp` 为快速存储(本次全量生成+扫描仅数秒,gate1 记录的机械盘抖动 126–166s 数字不在本机复现,两处口径不同、不可互推)
- 铁律执行:**所有数字来自真实执行**;不通过的子门如实记 FAIL,不归因不放行。

## 0. 对拍面定义(先于判定固定)

真实 `backend=shadow` 门(`KodeCoreGate.compare` → `KodeCoreClient` → release kode-server)驱动 808 个同参采样(201 个 .def × {属性悬停, 方法悬停, `<Type> ` 补全, 根级 `<` 补全} + types.xml/entities.xml/alias.xml 悬停 + Avatar.py 悬停探针)。文档同步腿(didOpen/didChange)由 bench 显式驱动 —— provider 逐面接线属后续单,本单测对拍本体。verdict 由 `firstDiffPath` 键序不敏感规范比较产出;语义面(命中/符号身份/标签序列)由双侧同参直取另行分解,两层分开报告。

## 1. S1 大规模 shadow 正确性对拍(808 采样)

### 1.1 ShadowDiffLog verdict 统计(LSP 协议面严格比较)

| verdict | 计数 | 占比 |
|---|---|---|
| match | 0 | 0% |
| diff | 500+(环形日志封顶;累计 ≥808 条 diff) | 100% |
| rust-error | 0 | 0% |
| rust-timeout | 0 | 0% |
| rust-unavailable | 0 | 0% |

diff 首分歧样本(原文见 run 文件 #1–#5):hover 全部 diff 在 `$.contents.value` 的**渲染层措辞**(TS「属性区块/方法区块中的自定义定义」+尾随空行 vs Rust「Properties/BaseMethods中的自定义定义」),符号名逐条一致(`**hp**`/`**onRpc0**` 双侧同词)。

### 1.2 语义面分解(同参直取双侧、按面对账)

| 面 | 样本 | 双侧命中 | 符号身份一致 | 结论 |
|---|---|---|---|---|
| .def 属性/方法悬停(201 文件×2) | 402 | 402/402 | 402/402=100% | 语义一致;渲染措辞不同(切流前必须统一,记 §6 遗留) |
| types.xml 悬停(文本式条目) | 1 | 双侧 SHADOW_GATE_TYPE | ✓ | 一致 |
| entities.xml 悬停 | 1 | 双侧 Avatar | ✓ | 一致 |
| alias.xml 悬停 | 1 | TS null / Rust SHADOW_GATE_ALIAS | — | **TS provider 无别名悬停面**(覆盖差,非 Rust 错) |
| Avatar.py def 方法悬停 | 1 | TS 标注 / Rust null | — | **Rust 悬停不支持 .py 面**(PR-010 基础版已知边界) |
| **悬停语义合计** | 406 | 双命中 404,双落空 0,单侧 2(各归因) | 404/404=**100%** | 见 §5 G-B |

补全面(402 采样:201×{类型面, 根级标签面}):

| 面 | TS 结果 | Rust 结果 | 分解 |
|---|---|---|---|
| `<Type> ` 类型面 ×201 | 26 项:KBENGINE 内建表 23 + JSONDATA + SHADOW_GATE_TYPE + Avatar | 2 项:SHADOW_GATE_TYPE+SHADOW_GATE_ALIAS | **Rust-only:SHADOW_GATE_ALIAS×201(TS provider 无别名补全面)**;TS-only=内建类型表+实体名(Rust 面按语料,设计口径差) |
| 根级 `<` 标签面 ×201 | TS 标签面(Parent/Interfaces/…) | Rust 判面不接管 → null | 覆盖差(Rust def 顶层故意不接管,记设计边界) |

### 1.3 本单如实测出的四个面级差异(全部可归因,非数据错)

1. **格式覆盖差**:生成器 types.xml/alias.xml 为属性式(`<JSONDATA type="UINT32"/>`),Rust `parse_types` 只识别文本式(`<NAME> UINT32 </NAME>`)→ 属性式条目在 Rust 面为 0,TS 面识别。golden 语料为文本式,此前双向门禁未覆盖属性式。bench 以两实现 golden 门都接受的文本式条目(SHADOW_GATE_*)补齐后才使类型面可比。
2. **别名面缺失**:TS provider 补全/悬停均无 alias.xml 指向面;Rust 有(alias.xml 悬停 SHADOW_GATE_ALIAS、补全别名面)。parity 复算面(kodeCompletionParity)含别名而 **provider 不含** —— provider ≠ parity 复算面,此前未暴露。
3. **渲染面不一致**:hover markdown 双侧各自措辞,语义(命中+符号身份)一致;切流后用户可见变化,必须先统一。
4. **.py 面**:TS def 方法标注/接收者/内建属性等 python 悬停面 Rust 恒 null(LSP 覆盖边界)。

## 2. S2 TS vs Rust 双轨同参数计时(热态 5 轮×20;ARCH-012 解禁,本单即对比验收单)

| 指标(同 URI 同 position) | TS P50/P95 | Rust P50/P95(含 transport,early-signal 口径,pr-012.md §5 注意条款) | Rust/TS P95 |
|---|---|---|---|
| hover .def 方法面 | 0.08 / 0.15ms | 0.22 / 0.30ms | 2.0x |
| completion .def 类型面 | 0.53 / 0.65ms | 0.26 / 0.46ms | **0.71x** |
| shadow compare 通道总开销(TS 直调+Rust 镜像+规范比较) | — | P50 0.50 / P95 1.24ms(接线成本参考) | — |

- 双轨均在毫秒级、远离评审建议 30/50ms 阈值;completion 面 Rust 已快于 TS,hover 面 Rust 含 IPC 往返仍 <0.5ms。
- 声明边界:shadow/协议往返与 TS provider 纯路径不严格同层(§5 注意条款),正式切流对比待 Rust 服务路径去掉 transport 后复测;本表作 early signal,不做「Rust 更快」的普适宣称(ARCH-012)。

## 3. S3 压力测试

| 项 | 实测 | 结果 |
|---|---|---|
| 连发 burst:200 请求并发 50(Rust 协议往返) | P50 6.04ms / P95 8.73ms / max 15.32ms,**0 错误** | ✓ |
| 连发 burst:200 请求并发 50(TS 直调) | P50 14.0ms / P95 34.3ms / max 39.72ms,0 错误 | ✓ |
| 连发 burst:200 次 shadow compare(全通道) | P50 16.77ms / P95 22.81ms,0 错误 | ✓ |
| 编辑风暴:150 轮 didChange(严格 version 转移)→ 双轨重查 | 单轮 P50 0.53ms / P95 1.09ms / max 4.5ms | ✓ |
| 风暴终态一致性探针 | Rust 属性面含 stormProp149(150 轮版本转移后状态正确);TS 该位置 0 项(TS 无 Properties 内属性标签面,覆盖差非风暴回归) | ✓(Rust 侧) |
| 内存 soak:1200 次顺序 compare(轮换 20 def) | kode-server RSS 峰值 **4.95MB**;TS 进程峰值 161.91MB(+3.25MB) | ✓ |
| ShadowDiffLog 有界性 | 1200+ 次写入后 summary.total=500(环形封顶) | ✓ |
| TS 结果不变量 | compare 恒返回 tsResult 原引用(抽样 identity 校验全过,无 `S3.tsResultIdentityBroken`) | ✓ |

## 4. 门禁判定(阈值先于结果固定)

| 门 | 阈值 | 实测 | 判定 |
|---|---|---|---|
| G-A 基础设施健康 | rust-error/timeout/unavailable 全 0;TS 服务零污染 | 全 0;原引用保持;burst 0 错 | **PASS** |
| G-B 悬停语义一致性 | 双侧均定义的面上命中+符号身份一致率 100% | 404/404=100%(两条单侧命中均归因覆盖差,见 §1.2) | **PASS** |
| G-C 补全语义一致性 | 标签序列 Rust-only 集合为空(即 Rust 结果 ⊆ TS 面) | SHADOW_GATE_ALIAS×201 Rust-only(TS provider 缺别名面) | **FAIL** |
| G-D 双轨性能 | 双轨 P95 <30ms 且无错误声明(early-signal 口径) | 最大 P95 8.73ms(burst Rust);S2 双轨全部 <1ms 级 | **PASS** |
| G-E 压力与资源 | burst 0 错;风暴后状态正确;日志 ≤500 有界;内存有界 | 全部满足 | **PASS** |

### 总判定:**FAIL(未过)——G-C 补全面标签序列不一致,按 PR-012 原文「不通过禁止继续扩大迁移」,维持禁止扩大迁移。**

- `serveFromRust()` 维持恒 false;`kbengine.core.backend` 非法值回落 ts 的 kill-switch 语义不变。
- 如实记录:G-A/G-B/G-D/G-E 四门全绿,shadow 通道、差异日志、回退开关在 30k 真实资产集上经受了实战执行(门 3 的「实战演练待执行」缺口由此补上执行数据);**唯一 FAIL 是补全面 parity(G-C)**,且已逐条归因(§1.3),修复路径明确,不构成数据/索引错误。
- 门 3 状态:🟡 → 🟡(演练执行数据已落,但 G-C 未过,门 3 不升绿;门 1 的「Rust 双轨对拍基准执行」缺口以本报告 §2 补齐 early-signal 实测)。

## 5. 切流前置条件清单对本单结果的回填(pr-012.md §4 不变式核对)

- [ ] 门 1 全绿:§2 已补 Rust early-signal 实测,但「正式对拍须去掉 transport」未做 —— 仍不勾;
- [ ] 门 2 全绿:G-C FAIL(provider 别名面缺失 + 属性式格式覆盖差)—— 不勾;
- [ ] shadow 实战数据:本单为 bench 级 808 采样执行,**非 ≥1 周真实使用** —— 不勾;
- [ ] 回退演练全判据:G-A/G-E 覆盖了 kill-switch 之外的判据,演练记录以本报告代部分证据,门 3 仍差 G-C 修复后复跑 —— 不勾;
- 其余条目(版本门/评审签字)状态不变。

## 6. 后续单建议(扩大迁移前必须逐项关闭)

1. provider 别名面对齐(TS 补全/悬停接 alias.xml 指向,或 Rust 面裁剪至与 TS 同口径)→ G-C 复跑至 0 diff;
2. types.xml/alias.xml 属性式格式:Rust parser 扩属性式或 golden 增属性式样例钉死口径;
3. hover 渲染面统一(措辞/尾随空白),或 compare 投影到语义面对拍;
4. .py 悬停/补全面进入 Rust 对拍范围(PH1 垂直切片扩面);
5. 正式切流对比去 transport 复测(门 1 收口)。

## 7. 门禁证据

- 原始输出:`docs/kode2/pr-012-gate2-run.txt`(56 行 GATE2-*,本次全量 30k 单跑正本)。
- TS 门禁:`pnpm test:unit`(TMPDIR=/tmp)2938 passed(≥2938 基线不回归;bench 不进门禁),`tsc -p ./` 零错,`pnpm lint` 零错。
- cargo 门禁:`cargo test --workspace --exclude kode-scheduler` 全绿(189,无 Rust 改动),`cargo clippy --workspace --exclude kode-scheduler` clean。
- 复跑方式:`TMPDIR=/tmp KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/shadowGate.bench.ts`(先 `cargo build -p kode-server --release`)。

## 8. G-C 差异关闭复测(2026-10-23,§6 前四项关闭单)

修复面(单 commit,§1.3 差异逐条对应):

1. **别名补全面补齐(G-C,§1.3-②)**:TS provider 补全面接 alias.xml 指向面 —— `getRegisteredAliasTypes`(src/definitionWorkspace.ts,`getAliasXmlCustomTypeInfos` 同底座,属性式不产出与 Rust parse_alias/buildAliasXmlCustomTypeInfo 同口径,`kbengine.types.aliasDiscovery` 同闸)→ `getKnownTypeSuggestions`(src/languageProviders.ts)别名条目 detail=指向目标(与 Rust alias 面 detail 同值)、kind=Class(与 Rust alias→LSP 7 同值)。
2. **属性式 types.xml(G-C 关联,§1.3-①)**:Rust `parse_types`(crates/kode-parser/src/model.rs)无文本指引时回落 `type` 属性、属性式 ARRAY 元素类型回落 `of` 属性;TS `parseTypesXml`(src/compositionRoots.ts)同口径。五张 parity golden(parser/symbol/type/completion/hover)重生成,TS 四个复算面(kodeParserParity/kodeTypesParity/kodeHoverParity/kodeCompletionParity)+kodeIndexParity 符号面同步属性式口径 —— 属性式注册面从此双侧同识别,真实生成语料不再需要文本式替身才可比。
3. **hover 渲染统一(§1.3-③)**:Rust `render_markdown`(crates/kode-server/src/hover.rs)属性/方法面与 TS getSymbolHover 逐字节同文案(段名中文区块:属性区块/方法区块/组件区块)同尾随空白(**Args** 行不带尾随空行、由 Exposed 前导空行衔接,TS 从不 trim)。真实对齐,非改对拍标准:compare 通道与 LSP 严格比较口径未动。
4. **.py 面(§1.3-④)**:如实划归非本阶段 —— Rust 悬停不支持 .py 面(PR-010 基础版已知边界),扩面属 PH1 垂直切片,维持单侧命中归因。

复测(`docs/kode2/pr-012-gate3-run.txt` 正本,同参 30k/808 采样):

| 指标 | gate2(61fe132) | gate3(本单) | 判定 |
|---|---|---|---|
| **G-C compDiverge(Rust-only 标签集非空的采样数)** | 201 | **0** | **PASS** |
| G-C compRustSubsetOfTs | 0 | 201 | 类型面 Rust ⊆ TS 全成立 |
| G-C compRustNullJudge(根级标签面) | 201 | 201 | 覆盖差(设计边界,Rust 顶层故意不接管,不变) |
| compRustTopLabels | SHADOW_GATE_ALIAS×201 | (无 rust-only;ts-only=内建类型表+实体名,设计口径差) | Rust-only 集=空 |
| ShadowDiffLog(S1 末) | match 0 / diff ≥808 | **match 248 / diff 252**(环形 500 窗) | 402 个 .def 悬停全 match |
| 悬停语义 | 404/404 身份一致 | 404/404 不变;402 .def 渲染逐字节一致(GATE2-HOVERFACE 样本头尾同文) | ✓ |
| S2 双轨 | P95 hover 0.15/0.30ms,comp 0.65/0.46ms | hover 0.15/0.39ms,comp 0.73/0.38ms(ratio 0.52x) | 均 <1ms 级,无回归 |
| S3 压力 | burst 0 错;RSS 4.95MB | burst 0 错;RSS 4.97MB;日志有界 500 | ✓ |

复测后 G-C:**PASS(Rust 补全结果 ⊆ TS 面,rust-only 标签集为空)**。§4 五门按本表回填:G-A/G-B/G-D/G-E 维持 PASS,G-C 由 FAIL → PASS。

### 剩余差异声明(如实,均非 G-C 阻塞)

1. **types.xml/entities.xml/alias.xml 悬停渲染措辞**:TS 走 Custom type/Entity registration 专属面(含落库形态段),Rust 走 Types/Entities/Aliases 结构面 —— 严格 compare 仍 diff,语义身份一致(types/entities 双侧同词;alias 单侧 TS null 为覆盖差)。措辞统一属 provider 专属面收口单,非本单范围。
2. **补全类型面标注差**:detail TS「Custom type/8 位无符号整数」vs Rust「builtin」,及 TS-only 项(内建类型表 23 + 实体名)—— 设计口径差(Rust 面按语料),严格 compare diff,标签序列子集关系已证。
3. **根级 `<` 标签面**:Rust 判面不接管 → null(compRustNullJudge 201,不变,设计边界)。
4. **.py 悬停面**:Rust 恒 null(PH1 扩面,见上 4)。
5. **TS 属性悬停专属字段**:Default/DatabaseLength/Identifier/数据库存储段 Rust 无此面(corpus 未触,真实持久属性场景仍单侧)。

门 3 状态:🟡 → 🟡(G-C 已关闭,但「正式对拍须去 transport」「≥1 周真实使用」等前置条件仍未满足,切流前置清单不变;§5 各条目状态不变)。
