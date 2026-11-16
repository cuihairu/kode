# RUST-144 批 3 验收纪实:SemanticTokens 决策核(semantic_tokens.rs+TS 双端)与增量 token 成本评测

日期:2026-11-16。todo 行:RUST-144(InlayHints 与 SemanticTokens;本批=SemanticTokens 新面:python 结构符号 span 提取+LSP 相对编码双端同构+golden 双向门禁+成本评测;批 4 候选=provider 装配面)。

## 交付面

- `src/backend/semanticTokens.ts`(新建,TS 生产决策核):legend 5 类 `['class','function','method','parameter','macro']`+2 修饰 `['declaration','async']`,`buildSemanticTokenSpans(text)`+`encodeSemanticTokens(spans)`;
- `crates/kode-server/src/semantic_tokens.rs`(新建,Rust 同构):纯库零 RPC,UTF-16 单元域;
- `crates/kode-server/src/bin/dump-semantic-tokens-golden.rs`+`crates/kode-server/tests/golden/semantic-tokens-parity.json`(8 语料/16 探测:spans 8+encoded 8)+`crates/kode-server/tests/semantic_tokens_golden.rs`(2 测试:重生成字节比对+结构完整性——升序/长度正/类型与修饰合法/5 元组);
- `tests/semanticTokens.test.ts`(3 钉:全类提取/伪声明与跨行/相对编码与未知类型 throw);
- `tests/kodeSemanticTokensParity.test.ts`(3 例:读 golden corpus+probes 驱动生产函数逐语料复算对拍,零注入);
- `crates/kode-server/src/def_param_hints.rs`:复用面(units/units_to_string/is_ident_start/is_ident_unit/index_from/parse_def_line)放宽 pub(crate),行为零改动;
- `src/defParamInlayHints.ts`:parseDefLine/splitParams 加 export(供 semanticTokens 复用,行为零改动);
- `docs/perf/2026-11-16-semantic-tokens-cost.md`:四档合成场景成本评测。

## 面清单

1. **类声明名**(class):parse_python_file 类表 × 掩码行 `class 名` 定位(掩码位置不变列对齐原文),modifiers=[declaration];
2. **方法声明名**(method):parse_python_file methods 表行/列直用;async 从掩码行 `^\s*async\s+def\s` 判,带则 modifiers 追加 async;
3. **模块级函数**(function):python_statements 语句面 `^\s*(async\s+)?def\s+名`,**类内 def 排除**(class_bound_def_lines=methods 表行集,不与 method 双记);
4. **装饰器**(macro):语句面非 def 时 `^\s*@\s*([\w.]+)` 点分全表达式,modifiers=[];
5. **形参**(parameter):parse_def_line(单行闭合闸,跨行不出)——**site.params 已剥首参 self/cls**,parameter 语义=RPC 形参与 inlay/签名同口径;declaration/async 修饰随声明名;
6. **编码**:LSP 相对 5 元组 [deltaLine,deltaStart,length,typeIndex,modifierBitmask],同行 deltaStart 相对/跨行绝对,未知类型抛错(装配面 bug 早爆);
7. 任何 python 文件都出(语言级结构语义,无实体段闸);语法关键字/字符串面留给 TextMate 不重叠。

## 真缺陷:self 形参未剥(钉即时拦截)

初版 collectParameterSpans 自行 splitParams(inner) 切名——**含 self**,行 4 `async def shoot(self, target, times=1)` 出 3 个 parameter。修=改用 parse_def_line 的 site.params(meaningful 已剥 self/cls),同时消灭重复扫描(不再二次 splitParams)。教训:同一 def 行的形参口径必须走同一个解析产物,inlay 面的剥离语义天然适用于 token 面。

## 坑账

1. **Rust 侧 require('vscode') 连坐**:out/defParamInlayHints.js 顶层 require vscode,成本驱动直跑 Node 需 Module._load patch stub(纯函数面运行时不触碰 vscode,顶层 import 连坐而已);
2. **大文件档两轮差异 ~3x**(794ms vs 2,220ms @94.5k 行):机器负载敏感,报告记两轮包络(既往 perf 基线同族抖动在案);
3. **正则移植手写扫描器**:JS `\s`/`\w` 手写(is_js_space 六字符/ident 表),async 可选分支的回溯语义(async 路失败回退裸 def 路)按正则回溯逐路径复刻;
4. serde `type` 字段:`token_type` 字段 `#[serde(rename="type")]`,camelCase rename_all 下显式 rename 优先。

## golden 语料(8 族)

mixed_classes(全类提取)/pseudo_decls(字符串注释伪声明+跨行 def 形参不出)/nested_class(嵌套类两类均可提取)/cjk_columns(CJK 注释列域+CJK 标识符 def 不产 span——`[A-Za-z_]\w*` ASCII 域,双端同构诚实)/async_heavy(模块级 async function+async 方法)/decorators_variants(带参装饰器 `@app.route("/x")` 点分截断+类内外装饰器)/annotated_params(注解/默认值/*rest/**kw)/only_comments(纯注释零 span)。

## prove-red(双端四靶,全闭环;cp 备份+变异+跑测+cp 还原+cmp 字节校验)

- Rust 靶 1:is_async_def_line 恒 false → full_extraction_async_and_params 红(modifiers 断言)→ 还原绿;
- Rust 靶 2:类内 def 排除闸 `true ||` 短路 → 2 单元钉+golden 重生成比对三重红 → 还原绿;
- TS 靶 1:encode deltaStart 相对改绝对 → 编码钉红 → 还原绿;
- TS 靶 2:装饰器分支 `false &&` 废掉 → kind(2) macro 断言红 → 还原绿(恢复后 6/6 绿)。

## 成本评测(docs/perf/2026-11-16-semantic-tokens-cost.md)

典型实体文件(240 行/310 span)build 1.9ms+encode 0.13ms;94.5k 行病理文件 build 794ms-2,220ms(两轮包络)+encode 15.6-48.7ms;100-span 可视区窗口编码恒 <0.05ms。**结论:增量面成本大头在 span 提取不在编码;批 4 provider 装配必须按文档版本缓存 span(versionKey 同纪律),病理大文件兜底策略留装配时与 RUST-147 一并裁度。**

## 诚实边界(批 4 候选)

provider 装配面(languages.registerDocumentSemanticTokensProvider/package.json semanticTokenTypes 声明/range 增量/真机验证)不做;self.X 属性访问与局部变量面不做(RUST-148 冲突矩阵裁度);语法关键字/字符串/数字面留给 TextMate grammar 不重叠。

## 门禁

eslint 0 / tsc 0 / vitest 全量 856 文件 10387+8skip RC=0 / xvfb demo 25 RC=0 / clippy(python+server,all-targets,-D warnings)0 / cargo 全量双 crate 0 failed(85 套件 ok) / prove-red 双端四靶闭环 / golden 重生成字节锁(16 探测)。
