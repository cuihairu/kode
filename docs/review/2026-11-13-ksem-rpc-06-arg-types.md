# KSEM-RPC-06 校验普通 RPC 参数类型

**日期**:2026-11-13
**条目**:`todo.md` KSEM-RPC-06 [P1]「校验普通 RPC 参数类型。验收:以 Arg 类型逐位置检查字面量及可推导变量,报告调用点/期望/实际/声明;动态 *args 保留未知。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 以 Arg 类型逐位置检查 | `rpcargs::check_rpc_args(declared, decl_line, call_line, call_args)`:声明侧 = 消费方对 `MethodView.args`(def `<Arg>` 匿名位类型文本)逐个 `SemType::from_type_graph` 解析后传入;兼容判定按引擎 `isSameType` 源码语义(datatype.cpp 逐行核,见 §2) |
| 字面量 | `CallArg::Literal(LiteralValue)`:Int(i128 防 UINT64 边界溢出)/Float/Str/Bool/None/Bytes/List/Dict/Set/Tuple;整族 + 值域精查(INT8..UINT64 逐宽转换界;UINT 负数拒 :279-289)+ 显式 `<Range>` 界(min/max 可解析才比) |
| 及可推导变量 | `CallArg::Variable{name, derived: Option<SemType>}`:推导类型经同一形态映射比对;**联合推导不任取分支**(RPC-03 同纪律 → Unknown);推不出 → Unknown 绝不硬判 |
| 报告调用点/期望/实际/声明 | `ArgReport{position, call_line, decl_line, expected(display), actual(形态证据文本), verdict}`;缺传/多传逐位报告(声明无此位「无此声明位」/缺位「未传(缺位)」) |
| 动态 *args 保留未知 | `StarArgs`/`KwArgs`:调用实参含任一动态展开 → 逐位与位数**全部 Unknown**(展开数不可知,不判确定性结论)——prove-red 变异三钉 |

## 2. 引擎真值(isSameType 逐行核过 ../kbengine datatype.cpp)

- 整型族 INT8..INT64/UINT8..UINT64:`PyLong_Check` + 逐宽转换(`:130/:260/:381` 系;UINT 族负数拒 `:279-289`)→ **bool 字面量同为 PyLong 子类,接受**;
- **FLOAT/DOUBLE:`PyFloat_Check` 单查(`:497/:587`)——整数字面量不接受**(引擎真值,非直觉「数值可转」语义;prove-red 变异一钉:天真 int→Float 兼容 → 5 例红);
- STRING/UNICODE:`PyUnicode_Check`(`:988/:1093`);BLOB:`PyBytes_Check`(`:1423`);PY_DICT/PY_TUPLE/PY_LIST:各自容器查(`:1255/:1311/:1367`);PYTHON:可 pickle 即接受(`:1177`);
- ENTITYCALL:EntityCall/None/Entity 三形态(`datatype.cpp:1484`,RPC-01 已钉)→ None 字面量对 Entity/Component/Nullable 声明兼容,对其余一律不符(引擎 isSameType 对 NULL 全拒);
- FixedArray:序列 + 逐元素 `isSameType`(`:1794-1812`)。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/rpcargs.rs` | 新模块:`CallArg`/`LiteralValue`/`ArgReport`/`ArgVerdict` + `check_rpc_args`(动态展开前置分流;逐位报告;None 特例;形态展开 Alias/Range/Nullable 穿透、Union 任意分支兼容、不可识别分支保留未知)+ 值域两表(int_bounds 族界/range_bounds 显式界);测试 14 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod rpcargs` 注册 |

## 4. 诚实边界

- ARRAY/FIXED_DICT 声明:位置层面只查容器形态(list/dict 字面量兼容),**元素/字段深入不在本批**(引擎 FixedArrayType 逐元素查 :1794-1812;字段面诊断族已有 CELL-08/09/10,消费接线归后续批次);
- 变量推导只吃 `derived: Option<SemType>`——RHS 推导(AST 归约)归 expr.rs/流引擎接线批次;本批保证「推不出 = Unknown 不硬判」;
- 调用实参含关键字实参形态(key=value)的归约本批未拆(消费方归约成 Literal/Variable/Opaque 后进来);`**kwargs` 动态红线覆盖之;
- isSameType 是形态闸,运行时 mailed 转换的执行力度(引擎是否硬拒)不在静态模型断言范围——本批按源码语义出报告,报告≠运行时必然错误,消费面措辞自持。

## 5. 证据

- `cargo test -p kode-server --lib semantics::rpcargs` 14/14(整族值域含 UINT64 边界/int→FLOAT 陷阱/bool 双向/str+容器五连/None 三向/变量三态/联合变量不任取+联合声明任一分支/*args **kwargs 全 Unknown/Opaque/缺传多传/PYTHON 全收/容器形态层/未知声明+别名穿透/Range 界);
- **prove-red=变异三发全咬合**:(1) int 天真兼容 FLOAT → 5 例红;(2) 抹 *args 未知红线 → star_args 红;(3) 变量推不出硬判 Compatible → variable_with_derived_type 红;恢复 14/14;
- 测试纠偏:`none_accepts` 初版对 Nullable 递归内层(INT32→拒)——Nullable 定义即接受 None,改为直判 true(测试抓出,实现错测试对,本批唯一一处);
- 门禁:clippy -p kode-server --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 301 含新 14);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
