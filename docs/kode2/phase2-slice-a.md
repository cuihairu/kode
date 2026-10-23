# kode2 Phase2 首片(slice-a):definition + diagnostics Rust 双轨面 + 对拍 + shadow 接入

状态:🟢 落地(不切流,serveFromRust 恒 false;PR-012 五门结论不变)。
正本:`docs/kode2/phase2-slice-a-run.txt`(bench 原始 GATE2-* 输出,重跑命令见文末)。

## 0. 本片交付

| # | 交付 | 落点 |
|---|------|------|
| ① | `textDocument/definition` Rust 响应链(UTF-16 定位→声明落点,复用 hover 定位基建)+ 与 TS 定义面**声明落点子面**对拍 golden(28 文件/76 落点) | `crates/kode-server/src/definition.rs`、`bin/dump-definition-golden.rs`、`tests/golden/definition-parity.json` |
| ② | `textDocument/diagnostic` Rust 面(LSP pull `kind:full`,TS validateDocument 语料子集逐条同文案同区间同序)+ 对拍 golden(20 文件/10 条) | `crates/kode-server/src/diagnostics.rs`、`bin/dump-diagnostics-golden.rs`、`tests/golden/diagnostics-parity.json` |
| ③ | 两面接进 backend=shadow compare(verdict 口径 + provider 接线 + 语料镜像腿)+ bench 扩面(S1 采样/S2 双轨计时) | `src/kodeCoreShadowFaces.ts`、`src/kodeCoreGate.ts(mirrorDocument)`、`tests/perf/shadowGate.bench.ts` |

双向门禁:Rust 侧 `definition_golden.rs`/`diagnostics_golden.rs` 重生成比对;TS 侧
`tests/kodeDefinitionParity.test.ts`(3 用例)/`tests/kodeDiagnosticsParity.test.ts`(3 用例)
用 defParser + kbengineMetadata 词表复算同一 golden,逐字段比对全绿。

## 1. 面定义(§对拍口径)

**definition 面 = 语料声明落点**(`definition_word` 四类文档):
- `.def`:声明符号词→本文件名字 span;`<Parent>` 取值词→语料内父/接口/组件 def 首行
  (缺失即 null);`<Type>`/`<of>` 取值词→语料内 types.xml 声明行首(内建 null);
- `entities.xml`:注册项词→语料内同名 def 首行(TS findEntityDefinitionFile 同口径);
- `types.xml`/`alias.xml`:声明词→本文件声明行首(TS findCustomTypeDefinition 同口径)。

**diagnostics 面 = TS validateDocument(.def,默认开关)语料子集**,顺序同 TS:
①标量扫描(全树 DFS 先序:未知 Type 引用/未知 Flags 值/未知 DetailLevel,Error);
②结构扫描(按段:重复定义 Properties 按旗标作用域 Warning+Info 成对、其余段同名
Warning+Info;属性缺 `<Type>`/`<Flags>` Error)。消息文案/区间规则
(值子区间 indexOf(contentStart)/节点整体区间 tagStart..closeTagEnd)逐条同 TS。

**划归边界(如实,不改 TS 侧任何行为)**:
- definition:TS F12 全脸中的 Python 脚本落点、数据库 schema 虚拟文档、kbe 桩、
  DetailLevel 档位行、属性/方法词的注册回落落点 —— Rust 语料面一律不产出;
  `alias.xml` 定义面 TS provider 无(恒 null)而 Rust 有(声明行落点)。
- diagnostics:`missingPythonFile` 分支(implementedBy 的 user_type Python 文件
  存在性需磁盘面)不在本面;kp-* 语法诊断不进对拍面(TS 面无语法维);
  语料类型环境 = 已入库语料并集(TS provider 生产口径为 workspace 发现)。

## 2. 两面对拍一致率(bench S1,30k 资产集 201 份 .def 采样 + 3 注册面)

| 面 | 样本 | 一致 | 一致率 | 分歧归属 |
|----|------|------|--------|----------|
| diagnostics(validateDocument 子集) | 201 | 201(其中双空 0,非空全等 201) | **100%** | — |
| definition 注册面(entities.xml/types.xml 声明词) | 3 | 2 | 2/3 | alias.xml:TS provider 无定义面(边界) |
| definition 声明词探针(.def 属性/方法词) | 402 | 0(双侧全命中但落点不同构) | 0%(边界探针) | F12 provider 脸(脚本缺失→注册回落 (0,0))vs Rust 声明名 span —— §1 划归边界,直对拍不进 diffLog |
| definition 对拍 golden(fixture 语料,face 定义内) | 76 落点 | 76 | **100%** | — |
| diagnostics 对拍 golden(fixture 语料) | 10 条 | 10 | **100%** | — |

shadow compare verdict(diffLog 有界 500;含 hover/completion 既有面):
`match 297 / diff 203 / failure 0` —— diff 全部为既有补全 Rust ⊆ TS 标签面
(201,gate3 口径不变)+ alias 定义边界 + 采样截断,无 rust-error/rust-timeout/
rust-unavailable。

## 3. bench 摘录(节选自 phase2-slice-a-run.txt;S2 5 轮×20 热态)

```
GATE2-ENV node=v24.21.0 platform=linux cpus=14 largeFiles=30000
GATE2-METRIC S1.samplesTotal 1009
GATE2-METRIC S1.diagMatch 201          # diagnostics 面 201/201 match
GATE2-METRIC S1.diagDiverge 0
GATE2-METRIC S1.defRegistryExact 2     # types.xml/entities.xml 声明词落点同构
GATE2-METRIC S1.defRegistryDiverge 1   # alias.xml:TS provider 无定义面(边界)
GATE2-METRIC S1.defDeclDiverge 402     # F12 脸 vs 语料声明面(§1 边界,直对拍)
GATE2-METRIC S1.defDeclBothMiss 0
GATE2-METRIC S2.definitionDefProp.ts.all n=100 p50=2.86ms p95=3.65ms
GATE2-METRIC S2.definitionDefProp.rust.all n=100 p50=0.41ms p95=0.88ms
GATE2-METRIC S2.definitionDefProp.ratioRustOverTsP95 0.24x
GATE2-METRIC S2.diagnosticsDef.ts.all n=100 p50=0.43ms p95=0.57ms
GATE2-METRIC S2.diagnosticsDef.rust.all n=100 p50=0.28ms p95=0.52ms
GATE2-METRIC S2.diagnosticsDef.ratioRustOverTsP95 0.91x
GATE2-METRIC S3.burstErrors 0          # 三通道 burst 200×并发 50 零错
GATE2-METRIC S3.soakServerRss.peakRssMb 5.04 MB
GATE2-METRIC S3.diffLogBounded500 1
```

样本摘录(GATE2-DEFFACE/REGFACE/DIAGFACE,serde_json 键序差异按 canonical 口径
判定,双侧内容全等):

```
GATE2-DIAGFACE #2 ts=[{range…line:2…},"severity":1,"message":"属性 hp 缺少 <Type> 定义"},…] rust=[{"message":"属性 hp 缺少 <Type> 定义","range":{…line:2…},"severity":1},…]
GATE2-REGFACE types.xml   ts={"uri":"…/large/scripts/types.xml","range":{line:2,char:0}} rust={"range":{line:2,char:0},"uri":"…/large/scripts/types.xml"}
GATE2-REGFACE entities.xml ts={"uri":"…/large/scripts/entity_defs/Avatar.def","range":{line:0,char:0}} rust={同}
GATE2-REGFACE alias.xml   ts=null rust={"uri":"…/alias.xml","range":{line:2,char:0}}   # §1 边界
GATE2-DEFFACE #1 probe=2:6 word=<hp type="UINT32"…  ts=(同文件 0,0 注册回落) rust=(同文件 2:5..2:7 名字 span)  # §1 边界
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

- `test:unit`(TMPDIR=/tmp):**2959 passed**(≥2940,+19:shadowFaces 13 +
  definition/diagnostics parity 各 3)。
- cargo workspace(excl. scheduler):**223 passed 0 failed**;clippy clean;fmt clean。
- `tsc -p ./` 零错;eslint(`src`)零错(tests/perf/shadowGate.bench.ts 存在一个
  HEAD 既有 `serverRss` 未用告警,非本片引入,不在 `pnpm lint` 范围)。
- bench 重跑命令(不进 pnpm test 门禁):

```
rm -f docs/kode2/phase2-slice-a-run.txt
TMPDIR=/tmp KODE_PERF_LARGE_FILES=30000 KODE_GATE2_OUT=docs/kode2/phase2-slice-a-run.txt \
  npx vitest run --config vitest.bench.config.ts tests/perf/shadowGate.bench.ts
```

## 6. 剩余差异与后续

- definition provider 脸与 Rust 语料声明面的划归边界(§1)如需收敛,属
  provider 脸下沉单(涉及 Python/schema/stub 落点面,超出本片)。
- `alias.xml` 定义面 TS provider 缺失:与 hover alias 行同款边界,如补 TS 侧
  面再翻此行。
- entities.xml 专项诊断面(validateEntitiesXmlDocument)未接,属后续片。
- bench S3 `stormFinalTsHasStormProp149=0` 与 gate2/gate3 基线口径一致
  (TS 触发面判定差异,既有记录),非本片回归。
