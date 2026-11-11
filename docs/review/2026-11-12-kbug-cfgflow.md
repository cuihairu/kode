# KBUG-CFGFLOW 分支可达性/流敏感写点 —— 修复纪实(2026-11-12)

账本:`todo.md` KBUG-CFGFLOW 组(审计基线 `10f4b85e`)。缺陷 = localReturnType
面写点裁定是**按行逆序取最后文本写点**(`local_return.rs` 旧 face_scan 三处
`.rev().find(w.line <= hover)`),无控制流模型:`if False` 内 str 写点污染外部
int、if/else 不同支按源码先后任取最后一支、return 之后的死写点照常入选、
循环/try 体写点覆盖入口确定值。

## 缺陷定位(修前)

- `crates/kode-python/src/local_return.rs`(旧 face_scan 函数域/类体/模块三处):
  `.iter().rev().find(|w| w.line <= start)`——文本序胜,分支可达性零建模;
  `if False: x = other()` 在 `x = make()` 之后查询 → 错答 Rock(账本复现例);
- `if/else` 两支不同写点 → 任取源码后写(误导性确定答案,而非未知);
- `return` 之后的不可达写点、循环保守路径、try 异常路径同样文本胜。

## 修复

1. **域语句流树(`self_flow.rs`)**:新 `FlowStmt` 树(BuildContext/FlowTables/
   FlowParse 三面携带)——AST 走查在 FunctionDef/ClassDef 臂建域树 + 模块树:
   - def/class 头 = 直线一步(体属他域;体内 `global` 写点借 span 命中,
     执行序 = 语句序);with 体平铺(直线执行);
   - `If`/elif 链(ruff 平铺 `elif_else_clauses` 重建嵌套 Branch):携带
     `test_const` 静态真值(`constant_bool`:布尔/None/数值/字符串/bytes 字面量
     + 一元 not;**名字不折叠**——可能被重绑定,不执行用户代码);
   - Loop(for/while/async for):保守(0 次执行入口值 + ≥1 次体出口并集);
   - Join(try/except/else/finally + match case):保守并集块;
   - Return/Raise/Break/Continue = Terminator(终止块内后序语句)。
2. **流值求值(`self_flow.rs::eval_block`)**:自域起点符号执行到 hover 行——
   直线写点替换语义(执行序后写胜);`if` 合流 = 各分支出口并集(**终止分支
   剔除** = CFGFLOW-04;**静态死分支不产出口** = CFGFLOW-02;**无 else =
   入口值路径参与** = CFGFLOW-03);循环/Join 保守并集 = CFGFLOW-05;
   `FlowVal::{Unbound, One(行), Many(候选集, maybe_unbound)}`——合流含未绑定
   路径即 maybe_unbound(诚实未知,绝不假装确定)。
3. **面消费(`local_return.rs::resolve_flow_val`)**:One 直解;Many 逐候选
   解析——**候选面全同 = 该面,不同 = 未知**,绝不按源码先后任取(CFGFLOW-03);
   maybe_unbound → 诚实空(可能 NameError);Unbound = 无可达写点(UnboundLocal
   /不可达位,SCOPE 3 方语义保留)。face_scan 三处写点选择全换流裁定(函数域
   树按 header_line 键、类体树按类名行键、模块树;无树域防御性退文本最近)。
   查询在静态死分支内/无条件终止后 = 不可达位,诚实空(CFGFLOW-01/02/06)。

## prove-red 与回归

- **修前红 12/14**(干净 HEAD 引擎 + 本批用例;stash 两源文件后把 CFGFLOW
  测试段插回 HEAD `local_return.rs` tests 模块内复跑,恢复后 diff 备份逐字节
  一致):`kbug_cfgflow_if_false_write_not_pollute`、
  `kbug_cfgflow_if_else_differ_honest_unknown`、
  `kbug_cfgflow_no_else_differ_honest`、`kbug_cfgflow_cond_only_write_maybe_unbound`、
  `kbug_cfgflow_terminated_branch_excluded`、
  `kbug_cfgflow_nested_def_return_not_terminate_outer`、
  `kbug_cfgflow_after_return_unreachable_honest`、`kbug_cfgflow_loop_conservative`、
  `kbug_cfgflow_loop_body_read_before_write_conservative`、
  `kbug_cfgflow_try_conservative`、`kbug_cfgflow_positions_flow_sensitive`、
  `kbug_cfgflow_query_in_dead_branch_honest`。
- **守卫例 2 例修前后同绿**:`kbug_cfgflow_if_true_definite_write`(静态确定
  分支照常命中)、`kbug_cfgflow_if_else_same_face_confluence`(两支同面合流
  仍命中——直线推断不过负)。
- **修后绿**:kode-python 286(local_return 62 例,含 CFGFLOW 14)、
  kode-server 614(含 `local_return_dispatch.rs` 15 例 = SCOPE 8 + BIND 4 +
  CFGFLOW 3,走完整 `$/kode/rpc` 链路:死分支不污染=可达面命中/两支不同=诚实空/
  循环保守=诚实空)、workspace 1906 全绿。

## 门禁

- Rust:`cargo clippy -p kode-python -p kode-server --all-targets -- -D
  warnings` 0;`cargo test --workspace` 1906 过 0 败。
- TS:`npm run lint` 0;`tsc -p ./` 0;`tsc -p tsconfig.mocha.json` 0;
  `npm run test:unit` 8683 过,1 例红 = 既知 `selfAttributeFlowRustParity`
  `KodeHotReload.py@199`(hot-reload 车道既有红,失败点与 ROOT/SCOPE/BIND 批
  记录逐字一致;本批不动 flow 面);上批两个超时例本轮满载通过(满载抖动族
  定性复核);`xvfb-run -a npm run test:demo:editor` 25 RC=0。
- parity 面:`pythonLocalReturnTypeRust` 7/7(**CFGFLOW 面改动零新增对拍
  分歧**);flow parity 仍仅 KodeHotReload 一处已知红。

## 命令

- 单测:`cargo test -p kode-python --lib local_return`(62 例)
- RPC 例:`cargo test -p kode-server --test local_return_dispatch`(15 例)
- prove-red 复现:stash `self_flow.rs`+`local_return.rs` → 把 CFGFLOW 测试段
  插回 HEAD `local_return.rs` → `cargo test -p kode-python --lib
  local_return`(12 failed)→ 恢复。

## 边界(诚实记录,未建模不硬造)

- 循环/break/continue/try/except/finally 不精确建模——保守并集(过近似 =
  诚实未知方向;账本明文要求保守,不回退文本写点);
- 条件只折叠**字面量**(布尔/None/数值/字符串/bytes + not);名字调用
  (`if cond`)、比较表达式不折叠——不执行用户代码,保留候选;
- `local_atom`/`callee_binding`(BIND 面)保持流不敏感——Python 名字**绑定
  存在性**是静态事实,CFGFLOW 只精化**值候选**的可达性;被调绑定值不因分支
  改变(BIND-05 共享事实不变);
- 同行多语句/多行语句内部的光标列精度归 KBUG-ORDER(流树按行粒度裁定,
  写点行 ≤ hover 行即已执行——与旧引擎行粒度同口径)。
