# RUST-152 审计结案:可复用 Python AST/语言服务分析能力对接与 Rust parser 验证

日期:2026-11-17
性质:审计结案(基线零改动)——「对接」与「先验证」两要求均已被既有线系统性满足。

## 对接现状:三路可复用能力,零自研轮子

1. **Rust AST(ruff_python_parser 封装)**:crates/kode-python(Cargo.toml 注释钉 C-20 令「Python 解析用 ruff_python_parser(Rust 原生,不造轮子)」);parse.rs `parse_unchecked_source` 容错解析(部分 AST+错误表,半成品/语法错文件尽力产出)+`line_col(offset)→(0 基行,0 基 UTF-16 列)` 来源定位;上层纯 Rust 决策核(symbols/callgraph/self_flow/in_file_resolve/semantic_tokens/def_param_hints/def_props_hints/serialization/layout 等)全部经此 AST。
2. **外部类型推断(pyrefly infer CLI)**:inferPipeline 对接 `pyrefly infer --python-version <v> --search-path <stubs>`(kbengine.infer.pythonVersion 门控,RUST-151 审计在案)。
3. **外部语言服务(Pylance/Pyright)**:RUST-148 冲突矩阵裁定分立——通用语义归 Pylance,Kode 只做 def 域语义,不复制不竞争。

## 「先验证覆盖率与来源定位」——已系统性验证

- **双端对拍**:19 个 parity 套件(tests/kode*Parity*.test.ts:definition/hover/completion/references/callAt/index/documentSymbols/diagnostics/defRename/defParamHints/defProps/codeAction/diagnosticPipeline 等)逐文件逐落点 TS↔Rust 复算比对,golden 锚 crates/kode-server/tests/golden/*.json+tests/fixtures/parity;
- **真实项目语料**:electron-ws 夹具(scripts/{base,cell,client}+entity_defs,FLOW-021 验收同源)驱动 definition/hover/completion/references/index/callAt/documentSymbols/defRename 套件;
- **全语料差异审计**:RUST-PRECISION-001 战役四批(A 流跨度/B 字面量/C in-file 推导/D 接收者级联)每批新引擎 vs 旧引擎全语料 diff 逐条过目,只接受改进/持平(docs 4421a6c6 线);
- **来源定位口径**:0 基行+UTF-16 列经 line_col 统一,LSP 5 元组编码面(semantic_tokens parity)钉换算正确性。

## 结论

任务两要求(对接可复用分析能力;Rust parser 先验证覆盖率与来源定位)均已由 ruff 封装+pyrefly 对接+Pylance 分工+19 parity 套件+全语料审计满足。基线零改动;后续新 Rust 决策核继续走同一验证纪律(parity+全语料审计),不另立流程。
