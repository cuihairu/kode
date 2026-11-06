# .def 原生 formatter 评估（KODE-FEAT-001 · 2026-11-05）

> 条目原文：评估 .def 原生 formatter（与 XML 解析器共享语法事实），先出评估
> 结论再定实现。
>
> 本文是评估结论，不实现代码。结论：**可行且值得做，推荐挂在 Rust core
> kode-parser 的精确 span 上（kode-server RPC 出 TextEdit），TS 侧只做
> provider 适配**。以下全部事实来自本工作树源码。

## 评估问题

1. 现有解析器的语法事实够不够支撑 formatter？
2. formatter 放哪一层（TS / Rust）？
3. 有哪些语义保持风险？

## 事实

### 解析器现状（两套，span 保真度不同）

- **Rust `crates/kode-parser/src/xml.rs`**：逐字节状态机，arena 树 +
  **精确字节 span**——每个元素保留 `open_span`/`close_span`/`content_span`/
  `name_span`，属性带 `name_span`/`value_span`，注释/CDATA/PI/声明各自有
  span；容错恢复（坏输入记诊断、局部恢复、不 panic）。这是 formatter 级
  的语法事实。
- **TS `src/defParser.ts`**：vendor 的 fast-xml-parser（fxp），**offset 靠
  `text.indexOf(node.text, searchOffset)` 二次搜索重建**（defParser.ts:541
  附近）——同名/同文本节点会错位，属导航级精度，不是 formatter 级。
  TS 侧无其他 XML 格式化依赖（package.json 无 prettier/xml formatter 依赖；
  `grep FormattingEdit src/` 零命中——扩展当前没有任何 formatter provider）。

### `.def` 格式的两个特殊语法事实

- **伪注释**：`#` 开头行（引擎历史格式，如截断头 `# <原本 80 列>`）。
  Rust 侧 `mask_def_pseudo_comments`（xml.rs:798）把这类行**字节等长**
  替换为空格后解析，因此伪注释行在原始文本里的位置仍落在 content span
  区间内——formatter 按 span 切原文时可以原样保留这些行。
- **引擎对该文件的格式不敏感**：.def 由引擎逐字节解析（属性/文本语义），
  空白变化不影响语义；但 def MD5（`def_md5.rs`/hotReloadDefHash）按内容
  哈希——**格式化必然改变内容 hash**，热更对账/MD5 比对会视其为变更。
  这是行为面事实，须写进将来实现的文档（formatter 不是语义无害操作，
  与热更状态机有交互）。

## 方案对比

| 方案 | 做法 | 判定 |
|---|---|---|
| A. TS 侧 formatter | 基于 defParser 的 indexOf offset 做重排 | **否**：offset 不精确，重排会把错位放大成内容损坏 |
| B. Rust core formatter | kode-parser span 树 → kode-server RPC 返回 TextEdit 列表 → TS `DocumentFormattingEditProvider` 适配 | **推荐**：span 精确、与 config-first「解析收 Rust 单一真源」方向一致、kode-server 已有同模式 RPC 面 |
| C. 引入外部 XML formatter 库 | prettier plugin / vscode-xml | 否：VSIX 零外部依赖是既成约束（fxp 已 vendor 即此因），且外部库不懂 `.def` 伪注释与引擎格式惯例 |

## 建议实现形态（供后续条目定案）

- Rust：`crates/kode-parser` 新增 format 模块（纯函数 `format_def(text,
  options) -> Vec<TextEdit>`），规则：按深度缩进（默认 4 空格，KBEngine
  官方 def 模板口径）、属性一行排布超宽折行可后议、注释与伪注释原样保留
  （按原文 span 逐字回写）、空行压缩规则保守（保留单空行）。
- RPC：kode-server 加 `kode/format/def` dispatch；TS：新
  `src/defFormatter.ts` 注册 formatting/range formatting provider，
  Rust 不可用时如实降级为无 provider（同 processTopologyRust 先例）。
- 验收口径（将来条目）：幂等（format(format(x))==format(x)）、语义等价
  （格式化前后解析树元素/属性/文本 token 逐节点相等）、伪注释逐字保留、
  容错（坏输入不出 edit 不 panic）、全量测试绿。

## 结论

1. **值得做**：Rust 解析器的 span 事实已就位，formatter 是薄层；
   TS 侧解析器不够格，方案 A 直接排除。
2. **推荐方案 B**（Rust core + RPC + TS provider 薄适配），与本仓库
   「解析收 Rust 单一真源」的 config-first 方向同轨。
3. **必须写进实现文档的行为面**：formatter 改变文件字节 → def 内容
   hash/MD5 随之改变，热更对账与引擎 MD5 握手会视格式化为真实变更；
   实现条目须在验收里明确这一交互（例如格式化后标记 DIRTY 的口径）。
4. 本条目按原文规格止于评估；实现待后续条目立项（依赖 config-first
   管道与 kode-server RPC 面的当前批次收口）。
