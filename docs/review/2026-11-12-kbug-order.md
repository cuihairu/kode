# KBUG-ORDER 同行赋值顺序/查询列精度 —— 修复纪实(2026-11-12)

账本:`todo.md` KBUG-ORDER 组(审计基线 `10f4b85e`)。缺陷 = 写点/查询粒度
只到「行」:`y = a(); x = y; y = b()` 同行三语句,别名回溯与最近写点裁定
按行取值,同行后续写点被吞/被借;`print(x); x = b()` 前读被整行末写点污染;
悬停列缺失时默认整行最后写点(误导)。

## 缺陷定位(修前)

- `crates/kode-python/src/self_flow.rs`:`BareWrite{line}` 只有行;流树
  `FlowStmt`/`FlowVal` 全部行粒度——同行多语句(分号/同赋值行)不可分序;
- `crates/kode-python/src/local_return.rs`:face_scan 以 hover 行 + 写点行
  裁定,别名递归 `face_scan(..., write.line, ...)` 无时间边界;
- RPC 面 `LocalReturnParams` 无查询列;TS 装配/hover 调用方不传列。

## 修复

1. **位置模型(`self_flow.rs`)**:新 `Pos{line, col}`(0 基行 + 0 基 UTF-16
   列,`line_col` 产物即 UTF-16,代理对计 2,与 VSCode `Position.character`
   同口径;字典序 = 源码执行序)。流树/流值全链 Pos 化:`FlowStmt` span、
   `FlowVal::One(Pos)/Many(Vec<Pos>)`、`eval_block` 查询参数、`span_has_write`;
   `BareWrite` 增 `col`(写点位)/`stmt_end`(所在语句末字符位)/`rhs_pos`
   (RHS 起始位);`push_entry` 三处收集点(Assign 元组配对逐元素/链式多目标/
   AnnAssign)记位。
2. **同行时间边界(`eval_block`)**:语句位域内查写点的生效判定 =
   `写点位 ≤ query 且 (query > 写点语句尾 或 query < RHS 起始位)`——悬在
   赋值目标位(先于 RHS)= 新值;悬在 RHS 内 = 语句前旧值(自引用
   `x = x` 读旧,ORDER-03);已越过本句(同行后句/经由 def 头跨度命中)
   = 已生效。执行完的语句(整句越过)沿用替换语义,执行序 = Pos 序。
   终止语句(return/raise/break/continue)span 扩为整句(悬 `return x`
   表达式位仍在句内,不误判「终止后不可达」)。
3. **别名回溯边界(`local_return.rs::resolve_face_shape`)**:Local 递归
   查询位 = 本写点 `rhs_pos`(只解严格先行的绑定)——同行/后续 `y = b()`
   不可见;元组同时赋值 RHS 边界统一取整个值元组起始位(交换语义:悬
   `x, y = y, x` 两目标各见对方旧值,悬 RHS 元素区一律旧值);
   visited 身份键升为 (行, 列, 名)。
4. **缺列保守规则(`local_return.rs::local_return_type`)**:新参
   `hover_column: Option<usize>`,缺省回退 hover 行首个非空白字符列
   (与整行光标旧口径一致;绝不伪造整行最后写点,ORDER-04)。
5. **协议与调用方传列**:RPC `LocalReturnParams` 增 `hoverColumn`
   (0 基 UTF-16;负值 = 缺列口径);TS `inferLocalReturnTypeFromRust` 增
   `hoverColumn?` 末位参数(源兼容);`hover.ts` 传 `position.character`
   (真实悬停列,ORDER-05 生产路径)。

## prove-red 与回归

- **修前红(干净 HEAD 引擎 + 本批用例;stash 三源文件 + 垫片 `order_query`
  (丢列调 HEAD 4 参签名)插回 HEAD `local_return.rs` tests 模块复跑,恢复后
  diff 备份逐字节一致)**:
  - Rust 单测 5/11 红:`kbug_order_read_before_write_same_line`(读前写点
    诚实空,HEAD 整行末写点污染)、`kbug_order_emoji_utf16_columns`(列 22/23
    同答,HEAD 无列精度)、`kbug_order_multiline_rhs_reads_old_then_new`
    (RHS 域内读旧值,HEAD 直取新值)、`kbug_order_tuple_swap_reads_pre_values`
    (交换见对方旧值,HEAD 行塌缩环防诚实空)、
    `kbug_order_self_reference_reads_prior_binding`(`x = x` 保前值,
    HEAD visited 诚实空);
  - RPC 2/3 红:`kbug_order_rpc_read_before_write_honest_null`、
    `kbug_order_rpc_explicit_column_distinguishes_same_line`(HEAD 忽略
    hoverColumn 退整行末写点)。
- **守卫例(修前后同绿)**:same_line_alias / multiline_alias(HEAD 行塌缩
  find-first 恰同答,保留为回归钉)、write_then_read、chained_assignment、
  comment_hover、unsupported_tuple_shape、negative_column(负列缺列口径)。
- **修后绿**:kode-python local_return 73(62 旧 + 11 新 ORDER)、
  kode-server local_return_dispatch 18(SCOPE 8 + BIND 4 + CFGFLOW 3 +
  ORDER 3)、workspace 1920 全绿。

## 门禁

- Rust:`cargo clippy -p kode-python -p kode-server --all-targets -- -D
  warnings` 0;`cargo test --workspace` 1920 过 0 败。
- TS:`npm run lint` 0;`tsc -p ./` 0;`tsc -p tsconfig.mocha.json` 0;
  `npm run test:unit` 8683 过,1 例红 = 既知 `selfAttributeFlowRustParity`
  `KodeHotReload.py@199`(hot-reload 车道既有红,失败点与 ROOT/SCOPE/BIND/
  CFGFLOW 批记录逐字一致);`xvfb-run -a npm run test:demo:editor` 25 RC=0。
- parity 面:`pythonLocalReturnTypeRust` 7/7(**ORDER 面改动零新增对拍
  分歧**);flow parity 仍仅 KodeHotReload 一处已知红。

## 命令

- 单测:`cargo test -p kode-python --lib local_return`(73 例)
- RPC 例:`cargo test -p kode-server --test local_return_dispatch`(18 例)
- prove-red 复现:stash `self_flow.rs`+两处 `local_return.rs` → 垫片 + ORDER
  测试段插回 HEAD → `cargo test -p kode-python --lib kbug_order`(5 failed)+
  `cargo test -p kode-server --test local_return_dispatch`(2 failed)→ 恢复。

## 边界(诚实记录,未建模不硬造)

- 链/类包含判定仍按行(`query.line`)——同行内部的光标列只进流求值边界,
  作用域链解析不需要列精度;
- 缺列保守回退 = 行首非空白列:单写点行照常答面;同行多语句行的缺列悬停
  落首语句位(诚实),不猜整行末写点;生产 hover 恒传真实列
  (`position.character`),缺列仅旧调用方/直连 RPC 面;
- `local_atom`/`callee_binding`(BIND 面)保持行粒度——名字**绑定存在性**
  是静态事实,ORDER 只精化**值候选**的时间边界(BIND-05 共享事实不变);
- 流树若/循环/try 保守性同 CFGFLOW(ORDER 只换位置粒度,不新增控制流建模);
- TS 兜底链(`resolveLocalVariableReturnTypeFromSnapshot`)保持行粒度——
  杀开关语义不变,列精度是 Rust-first 路径的增量。
