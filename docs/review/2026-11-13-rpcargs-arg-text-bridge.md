# 深审-2 def `<Arg>` 文本 → SemType 转换桥

**日期**:2026-11-13
**条目**:`todo.md` Codex 深审发现「实现 def Arg 文本到 `SemType` 的转换桥(`crates/kode-server/src/semantics/rpcargs.rs:78`)—— 打通真实 RPC 参数检查链并避免默认 PYTHON 过宽。」

## 1. 缺陷面(修复前)

RPC-06 `check_rpc_args` 的 `declared` 要求消费方自行把 def `<Arg>` 文本解析成
`SemType`,桥缺失=真实链未打通;而「图内查不到就兜 `Builtin("PYTHON")`」的
直觉写法是**吞光 mismatch 的伪实现**——PYTHON 的引擎语义是可 pickle 即接受
(datatype.cpp:1177),未识别名默认它=全部 Compatible,检查链形同虚设。

## 2. 引擎/仓库真值

- def `<Arg>` 真实形态=**单个 datatype 名**(可带空白;fixtures 实证
  `UINT32`/`VECTOR3`/types.xml 自定义名 `ENTITY_ID`);无内联 `ARRAY<>` 语法
  ——ARRAY/FIXED_DICT 经 types.xml 节点定义,按名引用;
- 内建表在 `kode_types::is_builtin`(INT8..64/UINT8..64/FLOAT/DOUBLE/STRING/
  UNICODE/PYTHON/PY_DICT/PY_TUPLE/PY_LIST/BLOB/ENTITYCALL/VECTOR2/3/4);
- `SemType::from_type_graph(graph,name,hops)` 已有递归面:is_builtin→Builtin、
  Alias/Array/FixedDict/UserType→Entity 逐层、无解析→Unknown("unresolved:名")。

## 3. 改动面

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/rpcargs.rs` | 新 `arg_text_to_sem_type(text, graph: Option<&TypeGraph>) -> SemType`:两端 trim;有图→`from_type_graph`(递归 alias/ARRAY/FIXED_DICT/UserType);无图+内建名→`Builtin` 直映;**无图+非内建→`Unknown("unresolved:名;type-graph-missing")`**;空文本→`Unknown("empty-arg-text")`。doc 注释钉死红线=未识别绝不默认 PYTHON,显式 `<Arg>PYTHON</Arg>` 才是合法 PYTHON。+10 测试(内建直映/trim/显式 PYTHON/未识别红线/空文本/alias/ARRAY+FIXED_DICT 递归/UserType→Entity/图缺未知/端到端喂 `check_rpc_args`) |
| `crates/kode-server/src/semantics/mod.rs` | rpcargs 模块文档条目(RPC-06 面+桥红线) |

## 4. 测试与 prove-red

- 端到端测试钉三态:UINT32+int 字面量=Compatible、FLOAT+int 字面量=引擎真值
  DefiniteMismatch(int 不过 PyFloat_Check)、无图未识别声明位=Unknown——
  **绝不因默认 PYTHON 而 Compatible**;
- **prove-red 三发全咬合**:
  1. 未识别臂改默认 `Builtin("PYTHON")` → 2 红(红线测试+端到端);
  2. 去掉 `trim()` → 1 红(trim 测试);
  3. 图臂改 `Builtin(name)` 直映(抹递归)→ 4 红(alias/ARRAY+FD/UserType/图缺未知);
  恢复均 `/tmp` 快照 cp + diff 字节一致。
- 协议 slip 如实记录:首轮 `/tmp` 快照误拍在写测试**之前**,变异 2 恢复把
  10 个新测试一并回滚(14 passed 假象、变异未咬)——发现后清变异→重落测试
  →**重拍快照**→重发变异 2/3,三发咬合口径以重发后为准。

## 5. 诚实边界

- 桥只管**单名**文本;若语料真出现内联复合形态(引擎不支持,深审已实证),
  解析层会把它当未知名进 Unknown,不猜;
- `hops=8` 与 `check_rpc_args` 现行别名穿透深度一致;超深链=alias-chain-overflow
  Unknown,不 hang 不硬解;
- 消费接线(RPC 诊断族把桥接进调用点检查的调度面)属后续诊断族批次,本批
  交付纯库面+契约。

## 6. 证据

- `cargo test -p kode-server --lib semantics::rpcargs` 24/24(14 既有+10 新);
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;
  cargo test 双 crate 55 套件 1189 过 0 败;tsc 0;eslint 0;vitest 747 文件
  RC=0;xvfb demo 25 RC=0。
