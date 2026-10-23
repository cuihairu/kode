# kode2 Phase2 首片(slice-a):definition + diagnostics Rust 双轨面 + 对拍 + shadow 接入

状态:🟢 落地(不切流,serveFromRust 恒 false;PR-012 五门结论不变)。
正本:`docs/kode2/phase2-slice-a-rerun.txt`(30k 资产集复测,原始 GATE2-* 输出;
重跑命令见 §5)。首轮记录 `docs/kode2/phase2-slice-a-run.txt` 保留作对照。

## 0. 本片交付

| # | 交付 | 落点 |
|---|------|------|
| ① | `textDocument/definition` Rust 响应链(UTF-16 定位→TS F12 落点链的语料子集,5 档)+ 与 TS 定义面对拍 golden(28 文件/74 落点) | `crates/kode-server/src/definition.rs`、`bin/dump-definition-golden.rs`、`tests/golden/definition-parity.json` |
| ② | `textDocument/diagnostic` Rust 面(LSP pull `kind:full`,TS validateDocument 语料子集逐条同文案同区间同序)+ 对拍 golden(20 文件/10 条) | `crates/kode-server/src/diagnostics.rs`、`bin/dump-diagnostics-golden.rs`、`tests/golden/diagnostics-parity.json` |
| ③ | 两面接进 backend=shadow compare(verdict 口径 + provider 接线 + 语料镜像腿)+ bench 扩面(S1 采样/S2 双轨计时) | `src/kodeCoreShadowFaces.ts`、`src/kodeCoreGate.ts(mirrorDocument)`、`tests/perf/shadowGate.bench.ts` |
| ④ | hover 属性面字段对齐 TS:补 `Default`/`DetailLevel`/`DatabaseLength`/`Identifier`,去掉 TS 不渲染的 `Persistent`;golden 同步重生成(28 文件/92 悬停) | `crates/kode-server/src/hover.rs`、`tests/golden/hover-parity.json` |

双向门禁:Rust 侧 `definition_golden.rs`/`diagnostics_golden.rs`/`hover_golden.rs` 重生成比对;
TS 侧 `tests/kodeDefinitionParity.test.ts`(3 用例)/`tests/kodeDiagnosticsParity.test.ts`(3 用例)/
`tests/kodeHoverParity.test.ts`(4 用例)用 defParser + kbengineMetadata 词表**独立复算**同一
golden,逐字段比对全绿。

## 1. 面定义(§对拍口径)

**definition 面 = TS F12 落点链的语料子集**(按 TS 求值顺序,命中即返回):

1. `<DetailLevel>` 取值词 → 本文件 `<DetailLevels>` 档位声明行(`findDetailLevelDefinitionInDef` 同口径);
2. `<Parent>` 取值词 → 语料内父 def 首行(接口回落 `interfaces/`、组件槽回落 `components/`,缺失 null);
3. `<Type>`/`<of>` 取值词 → 语料内 types.xml 声明行(内建类型 null);
4. Properties/三方法段的声明词 → **注册回落**:脚本层(略,见边界)→ `scripts/entities.xml`
   同名项行 → `<defs>/entities.xml` 同名项行 → 本文件 `(0,0)`(`findRegistryFallbackLocation` 同口径);
5. 组件段落的声明词 → null(TS provider 链末尾同 null,不做单侧增强);
   `entities.xml` 注册词 → 同名 def 首行;`types.xml`/`alias.xml` 声明词 → 本文件声明行首。

顺序即 TS 语义:第 1 档优先于第 4 档(DetailLevel 取值词同时是某属性名时不落注册面),
第 2/3 档只对取值为本文件 `<Parent>`/`<Type>` 的词生效。

**diagnostics 面 = TS validateDocument(.def,默认开关)语料子集**,顺序同 TS:
①标量扫描(全树 DFS 先序:未知 Type 引用/未知 Flags 值/未知 DetailLevel,Error);
②结构扫描(按段:重复定义 Properties 按旗标作用域 Warning+Info 成对、其余段同名
Warning+Info;属性缺 `<Type>`/`<Flags>` Error)。消息文案/区间规则
(值子区间 indexOf(contentStart)/节点整体区间 tagStart..closeTagEnd)逐条同 TS。

**划归边界(如实,不改 TS 侧任何行为)**:

- definition 第 4 档的 **Python 脚本层**:TS 的顺序是「DetailLevel → 脚本四档(类行/
  `__init__`/首个类行/首行)→ 注册 → 本文件」,Rust 无 `.py` 语料,跳过脚本层直接注册。
  这是 402 声明词探针唯一残余(1/402)的成因,量化与补齐方案见
  `docs/kode2/phase2-py-face-gap.md`(P1 落点层落地后自然闭合到 402/402)。
- definition:数据库 schema 虚拟文档、kbe 桩不产出;`alias.xml` 定义面 TS provider 无
  (恒 null)而 Rust 有(声明行落点)。
- diagnostics:`missingPythonFile` 分支(implementedBy 的 user_type Python 文件
  存在性需磁盘面)不在本面;kp-* 语法诊断不进对拍面(TS 面无语法维);
  语料类型环境 = 已入库语料并集(TS provider 生产口径为 workspace 发现)。

## 2. 两面对拍一致率(bench S1,30k 资产集 201 份 .def 采样 + 3 注册面)

| 面 | 样本 | 一致 | 一致率 | 分歧归属 |
|----|------|------|--------|----------|
| diagnostics(validateDocument 子集) | 201 | 201(双空 0,非空全等 201) | **100%** | — |
| definition 注册面(entities.xml/types.xml 声明词) | 3 | 2 | 2/3 | alias.xml:TS provider 无定义面(边界) |
| definition 声明词探针(.def 属性/方法词) | 402 | **401** | **99.75%** | 1 条 = `.py` 脚本层(§1 边界);TS `Avatar.py:0:0` vs Rust `entities.xml:1:0` |
| definition 对拍 golden(fixture 语料) | 74 落点 | 74 | **100%** | — |
| diagnostics 对拍 golden(fixture 语料) | 10 条 | 10 | **100%** | — |
| hover 对拍 golden(fixture 语料,含属性四字段) | 92 悬停 | 92 | **100%** | — |

shadow compare verdict(diffLog 有界 500;含 hover/completion 既有面):
`match 297 / diff 203 / failure 0` —— diff 全部为既有补全 Rust ⊆ TS 标签面
(201,gate3 口径不变)+ alias 定义边界 + 采样截断,无 rust-error/rust-timeout/
rust-unavailable。

402 探针的语义分解(直对拍,不进 diffLog):`defDeclExact 401`、`defDeclDiverge 1`、
`defDeclTsOnly 0`、`defDeclRustOnly 0`、`defDeclBothMiss 0`。
唯一分歧正本:

```
GATE2-DEFFACE-DIFF #1 file=…/Avatar.def probe=2:6 word=hp
  ts   = …/scripts/base/Avatar.py  line 0 char 0     # 脚本类落点
  rust = …/scripts/entities.xml    line 1 char 0     # 注册回落(跳过脚本层)
```

## 3. bench 摘录(节选自 phase2-slice-a-rerun.txt;S2 5 轮×20 热态)

```
GATE2-ENV node=v24.21.0 platform=linux cpus=14 largeFiles=30000
GATE2-METRIC S1.samplesTotal 1009
GATE2-METRIC S1.diagMatch 201          # diagnostics 面 201/201 match
GATE2-METRIC S1.diagDiverge 0
GATE2-METRIC S1.defRegistryExact 2     # types.xml/entities.xml 声明词落点同构
GATE2-METRIC S1.defRegistryDiverge 1   # alias.xml:TS provider 无定义面(边界)
GATE2-METRIC S1.defDeclExact 401       # 402 声明词探针:401 命中
GATE2-METRIC S1.defDeclDiverge 1       # 唯一残余 = .py 脚本层
GATE2-METRIC S1.defDeclBothMiss 0
GATE2-METRIC S1.hoverBothHit 404       # 404 悬停身份双侧命中,nameAgree 404
GATE2-METRIC S1.hoverNameDisagree 0
GATE2-METRIC S2.definitionDefProp.ts.all n=100 p50=1.82ms p95=2.33ms
GATE2-METRIC S2.definitionDefProp.rust.all n=100 p50=0.26ms p95=0.39ms
GATE2-METRIC S2.definitionDefProp.ratioRustOverTsP95 0.17x
GATE2-METRIC S2.diagnosticsDef.ts.all n=100 p50=0.32ms p95=0.53ms
GATE2-METRIC S2.diagnosticsDef.rust.all n=100 p50=0.18ms p95=0.25ms
GATE2-METRIC S2.diagnosticsDef.ratioRustOverTsP95 0.47x
GATE2-METRIC S3.burstErrors 0          # 三通道 burst 200×并发 50 零错
GATE2-METRIC S3.soakServerRss.peakRssMb 5.04 MB
GATE2-METRIC S3.diffLogBounded500 1
```

样本摘录(GATE2-DIAGFACE/REGFACE/DEFFACE,serde_json 键序差异按 canonical 口径
判定,双侧内容全等):

```
GATE2-DIAGFACE #2 ts=[{range…line:2…},"severity":1,"message":"属性 hp 缺少 <Type> 定义"},…] rust=[{"message":"属性 hp 缺少 <Type> 定义","range":{…line:2…},"severity":1},…]
GATE2-REGFACE types.xml   ts={"uri":"…/large/scripts/types.xml","range":{line:2,char:0}} rust={"range":{line:2,char:0},"uri":"…/large/scripts/types.xml"}
GATE2-REGFACE entities.xml ts={"uri":"…/large/scripts/entity_defs/Avatar.def","range":{line:0,char:0}} rust={同}
GATE2-REGFACE alias.xml   ts=null rust={"uri":"…/alias.xml","range":{line:2,char:0}}   # §1 边界
GATE2-DEFFACE #1 probe=2:6 word=hp  ts=(脚本层) rust=(注册行)  # 唯一分歧,见 §2 DEFFACE-DIFF
```

## 4. shadow 接入(不切流)

- `KodeCoreGate.compare` 新增 `textDocument/definition`、`textDocument/diagnostic`
  两个 verdict 方法(五 verdict 口径不变,canonicalize/firstDiffPath 复用)。
- `KodeCoreGate.mirrorDocument`(语料镜像腿):shadow 会话内把 .def 文档
  open/change 同步给 Rust(版本账单调,回退走 close+open,不虚构版本;
  失败静默,verdict 归 compare 自身失败分类);kill-switch 即清账停进程。
- provider 接线点(`src/languageProviders.ts`,fire-and-forget,不改返回值):
  - `KBEngineDefinitionProvider.provideDefinition` → 适配 LSP 面
    → `compare('textDocument/definition')`;
  - `validateDocument` → `shadowObserveDefDocument`(镜像 + 诊断面对拍)。
  - 门引用经 `setupKodeCoreGate` 注入 `kodeCoreShadowFaces`(默认 null =
    全部入口零开销直通;gate dispose 时撤引用)。
- 默认 backend=ts 下零用户可见变化(2959 单测含 PR-012 默认锁死面全绿);
  `serveFromRust()` 恒 false,§4 切流前置清单未动。

## 5. 验证记录

- `test:unit`(TMPDIR=/tmp):**2959 passed / 7 skipped**(209 文件通过,1 跳过)。
- cargo workspace:**250 passed 0 failed**;本片三 crate 单跑 **136 passed**。
- `clippy --lib --bins --tests -D warnings`:clean。
  (`--all-targets` 会命中 `crates/kode-parser/examples/head2head.rs:198` 的
  `redundant_iter_cloned` —— HEAD 既有、本片未触、clippy 1.99 新 lint,不在本单修。)
- `fmt`:本片改动文件 clean;`cargo fmt --all --check` 仅报 HEAD 既有漂移
  (`crates/kode-index/tests/symbol_golden.rs`、`examples/head2head.rs`),未触不修。
- `tsc -p ./` 零错;eslint(`src`)零错。
- bench 重跑命令(不进 pnpm test 门禁):

```
rm -f docs/kode2/phase2-slice-a-rerun.txt
TMPDIR=/tmp KODE_PERF_LARGE_FILES=30000 KODE_GATE2_OUT=docs/kode2/phase2-slice-a-rerun.txt \
  npx vitest run --config vitest.bench.config.ts tests/perf/shadowGate.bench.ts
```

`.py` 面采样(默认关闭,~110s @30k,仅预研):

```
TMPDIR=/tmp KODE_PERF_LARGE_FILES=30000 KODE_PYFACE_PROBE=1 \
  KODE_GATE2_OUT=docs/kode2/phase2-py-face-probe.txt \
  npx vitest run --config vitest.bench.config.ts tests/perf/shadowGate.bench.ts
```

## 6. 剩余差异与后续

- **`.py` 面**(definition 第 4 档脚本层 + hover 面):缺口量化、分层与门禁见
  `docs/kode2/phase2-py-face-gap.md`。本片不实现;P1 落点层落地后 402 探针闭合到 402/402。
- `alias.xml` 定义面 TS provider 缺失:与 hover alias 行同款边界,如补 TS 侧
  面再翻此行。
- entities.xml 专项诊断面(validateEntitiesXmlDocument)未接,属后续片。
- PR-012 §8 剩余边界(三面)的逐项定案见 `docs/kode2/pr-012-perf-gate.md` §8.1。
- bench S3 `stormFinalTsHasStormProp149=0` 与 gate2/gate3 基线口径一致
  (TS 触发面判定差异,既有记录),非本片回归。
