# kode2 Phase2 `.py` 面 Rust 扩面:量化缺口清单 + 方案(本单不实现)

状态:🟡 预研。**Rust 代码零改动**(不新增 `FileKind::Python`、不开 serveFromRust);
正本数据 `docs/kode2/phase2-py-face-probe.txt`(30k 资产集,`KODE_PYFACE_PROBE=1` 采样)。

本单要回答三件事:缺口有多大(可量化)、缺口分成哪几层(可独立交付)、
按什么顺序补(风险/门禁),不回答"现在就写"。

## 1. 缺口事实(实测,非估算)

| 事实 | 数值 | 证据 |
|---|---|---|
| 30k 资产集 `.py` 文件数 | **30001** | `GATE2-METRIC S1.pyFaceFilesLarge 30001` |
| Rust 识别的文件类别 | 4(`.def`/`entities.xml`/`types.xml`/`alias.xml`) | `crates/kode-parser/src/dep.rs:78-91` |
| 其余类别在 definition/hover/completion 入口 | 直接 `None` | `definition.rs:113`、`hover.rs:411`、`completion.rs:124` |
| `.py` 探针(3 文件 / 6 个 `def` 词)hover | TS 命中 1 / **Rust 命中 0** | `S1.pyFaceSample` |
| 同一批 definition | TS 命中 1 / **Rust 命中 0** | 同上 |
| definition 402 声明词探针残余分歧 | **1 条**,即 TS 的 `.py` 脚本层 | `S1.defDeclDiverge 1` + `GATE2-DEFFACE-DIFF #1` |

关键点:**"大文件量"的主体就是 `.py`**。30k 语料里 30001 个 `.py`、201 个 `.def`,
Rust 侧 definition/hover/diagnostics 的语料面全部落在 201 个 `.def` 与 3 个 xml 上。
所以 `.py` 不是边角料,而是 Rust 尚未覆盖的 99% 文件体量。

VFS 侧**已经**把 Python 分类出来(`crates/kode-vfs/src/walk.rs:39` 的
`FileKind::Python`),缺的是解析/索引/语义面 —— 发现 ≠ 入库 ≠ 可应答。

## 2. 残余 1 条分歧的正身(与首片 ① 的接缝)

`scripts/entity_defs/Avatar.def` 的属性词 `hp`(探针 2:6):

```
TS   → scripts/base/Avatar.py  (0,0)      # findPropertyScriptLocationInDef:脚本存在 → 类/首行
Rust → scripts/entities.xml    (1,0)      # registry_landing:跳过脚本层,直接注册行
```

TS 的属性链是「DetailLevel 档位 → 脚本(四档落点) → DB schema 虚拟文档 → 注册行 →
def 首行」(`src/languageProviders.ts:2260-2290、2846-2860`);Rust 首片实现了
档位层与注册层,中间两层按能力边界跳过。**这 1 条不是落点算错,是 `.py` 层不存在**:
补上第 3 节 P1 即闭合到 402/402,不需要改对拍口径。

## 3. TS 面清点(要对齐的能力,不是全部都要补)

| # | 能力 | TS 落点 | 规模 |
|---|---|---|---|
| G1 | 语料/类方法索引 | `src/pythonClassIndex.ts`、`pythonLanguageUtils.ts` | 1307 + 308 行 |
| G2 | 定义(F12) | `PythonDefinitionProvider`(`languageProviders.ts:3407`) | 类/方法/`self.` 成员/基类 MRO |
| G3 | 悬停 | `KBEngineHoverProvider` python 面 + `pythonReturnTypeInference.ts` | 249 行(类型推断) |
| G4 | 补全 | `PythonCompletionProvider`(`languageProviders.ts:4550`) | 成员/实体方法/事件名 |
| G5 | 诊断 | `missingPythonFile` 分支(`crates/kode-server/src/diagnostics.rs:13` 已列为边界) | 存在性 + kp-* 语法维 |
| G6 | 元数据面 | `pythonTypeStubs.ts` 611、`pythonStubExport.ts` 479、`typeInlayHints.ts` | 依赖引擎 API 元数据 |

`src/python*.ts` 合计 **3174 行**;G1+G2 是 definition/hover 对齐的最小闭包,
G6 与 `.def`/xml 面正交,不该并进同一切片。

## 4. 缺口分层(可独立交付的边界)

- **P0 语料层(前置,全部依赖它)**:Python 缩进语法的最小 AST —— `class`(含基类)、
  `def`(含装饰器/async)、`self.x = ...` 赋值、`import`。产出 4 张表(类/方法/属性/导入),
  与 TS `pythonClassIndex` 对拍 golden。
- **P1 落点层(闭合首片残余 1 条)**:脚本存在性 + 同名类行 → `__init__` → 首个类行 →
  首行四档(`resolvePropertyLandingLine` 同口径),方法实现落 `def` 名字 span。
- **P2 悬停/补全层**:`self.` 成员解析 + 返回类型推断(TS 249 行的同口径),接
  `HoverEngine` 的现有渲染器(属性/方法区块文案已与 TS 逐字节同)。
- **P3 诊断层**:`missingPythonFile` 只需文件存在性(磁盘/VFS 面),可先于语法诊断落地;
  `kp-*` 语法诊断 TS 侧另有面,单独对拍。
- **P4 元数据层**:inlay hints / code lens / stub 导出,依赖引擎 API 元数据,单独立项。

## 5. 方案与门禁(建议顺序,含估算)

| 阶段 | 内容 | 估算 | 出门门禁 |
|---|---|---|---|
| P0 | tokenizer + 4 表 + golden 对拍 | Rust ~1.5–2k 行 | 与 TS `pythonClassIndex` 四表逐条等值;30k 语料扫描 P95 记录 |
| P1 | 脚本四档落点 + 方法实现 | ~300 行 | 402/402 声明词全等;definition golden 扩 `.py` 面 |
| P2 | 成员 hover/补全 | ~800 行(含推断) | hover parity golden(逐字节)+ S1 hoverBothHit 不降 |
| P3 | `missingPythonFile` → 语法诊断 | ~400 行 | diagnostics golden 扩分支;201 条既有诊断不变 |
| P4 | inlay/codelens/stub | 另立项 | 元数据面独立对拍 |

风险与约束:

1. **oracle 只能是 TS**:Python 是动态语言,落点/hover 全是启发式,任何"更正确"的
   Rust 实现都会变成新分歧。P0–P2 一律以 TS 行为为验收标准。
2. **性能基线**:TS `PythonClassIndex` 首次查询会全量扫描 —— 30k 语料实测让 bench
   从 6.2s 涨到 **117.7s**(本单为取 6 个探针付的代价,`phase2-py-face-probe.txt` 同参)。
   Rust 侧必须在 P0 就把索引做成增量(现有 `SymbolIndex` 的指纹重建同款),
   否则"更快"的前提不成立。
3. **不切流**:P1–P3 完成前 `serveFromRust()` 仍恒 false;`.py` 面单侧命中继续按
   `pr-012-perf-gate.md` §8 的边界声明记账。

## 6. 本单明确不做

- 不加 `FileKind::Python` / `FileKind::Py`,不动 `file_kind_of_uri` 的四类判定;
- 不实现 Python tokenizer/parser,不产出任何 `.py` 的 definition/hover 结果;
- 不改 §8 的 strict compare 口径(单侧命中仍是 diff,不做"跳过即对齐");
- 不把 bench 的 `KODE_PYFACE_PROBE` 采样并进默认门禁(默认 6.2s 不变)。
