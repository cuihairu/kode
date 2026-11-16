# ADR-105 — Python 分析三层复用(ruff AST + pyrefly infer + Pylance/Pyright 分工),不自研第二套完整 Python LS

- 状态:已接受(2026-11-17,RUST-292 裁决落档;三层 de-facto 在役,本 ADR 追认并钉边界)
- 关联:书 §18 ADR-105、RUST-292、RUST-152(复用对接审计,2026-11-17 结案)、RUST-148(矩阵分立不复制)、C-20 令(ruff_python_parser 0.0.20 版本钉)、KODE-CFG-017(pyrefly infer 管道)
- 证据:`docs/review/2026-11-17-rust-152-reusable-python-analysis-audit.md`(三路对接零自研轮子+19 套件验证纪律)、`crates/kode-python/src/parse.rs`(ruff 封装)、`src/pyreflyInfer.ts`(CLI shell-out)、`docs/guide/configuration.md` CFG-017 节

## 背景

书 ADR-105:优先复用成熟 Python 工具的行为,避免维护第二套完整 Python LS。
kode 的 Python 面是 KBEngine 域语义(self 流、RPC 形参、实体类型链),不是
通用 Python 语言服务;通用面与 Pylance/Pyright 重叠。

## 决策

**三层复用,各管一段,kode 不做通用 Python LS:**

1. **AST 层 = ruff_python_parser**(版本钉 Cargo.toml,C-20 令):容错解析
   (部分 AST+错误表)+ `line_col` 0 基行/UTF-16 列统一来源定位;Rust 决策核
   (self_flow/local_return/callgraph/symbols 等)全部经此 AST,零自研解析器。
2. **未注解推断层 = pyrefly infer CLI**(shell-out,`--python-version` 走
   `kbengine.infer.pythonVersion`):产物落 `.kbengine/inferred` 镜像,用户真码
   永不改; kode 消费面做差分富化(diffInferredAnnotations/inferredEnrichment)。
   **pyrefly stubgen 车道实测不采用**(对无标注代码全落 `Incomplete`,
   CFG-017 实测结论);crates.io `pyrefly` 为 0.0.1 占位包,库直集成不可行,
   维持 CLI。
3. **通用 LS 层 = Pylance/Pyright**:通用补全/类型检查/跳转归其所有,
   RUST-148 矩阵分立不复制;kode 只做域语义深化(def `<Arg>` 形参闸/RPC
   inlay/self 流/实体导航),通过 typings/stub 接线与其共存(ADR-110)。

## 后果

- 正面:零第二套解析器维护;ruff 容错解析质量随上游;推断能力随 pyrefly;
  19 个 parity 套件(TS↔Rust 逐文件逐落点)守行为等价,升级有回归网
  (RUST-152 审计验证纪律,后续新核同轨)。
- 负面/约束:三层边界要持续守——通用面 slightest 重叠即裁(RUST-148 矩阵);
  ruff 版本钉升级需对拍全绿;pyrefly CLI 不可用时要诚实降级
  (拒绝原因不静默,RUST-158 未知保留口径)。
- reopen 条款:pyrefly 稳定提供库集成或 stubgen 质量达标时重评第 2 层形态;
  ruff 出现破坏性 span 语义变更且无迁移路径时,评估 fork/锁版本/换 tree-sitter
  (需新 ADR+基准证据)。
