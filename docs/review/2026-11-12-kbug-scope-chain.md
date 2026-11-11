# KBUG-SCOPE 词法作用域链 —— 修复纪实(2026-11-12)

账本:`todo.md` KBUG-SCOPE 组(审计基线 `10f4b85e`)。缺陷 = localReturnType
面的域门是**缩进回溯**(`local_return.rs` 旧 `face_scan`:自 hover 行向上,
`indent < limit` 放行,def/class 名行窄化 `indent+1`),不建模 Python 词法
作用域:参数不注册为绑定(模块 `x` 借给 `def run(x)` 体)、函数体写点外溢
到 def 结束后的模块行、嵌套函数体写点外溢到外层行、类体直系写点被方法体
裸名借用(误导:`self.x` 与裸 `x` 语义不同)。

## 缺陷定位(修前)

- `crates/kode-python/src/local_return.rs:79-110`(旧 `face_scan`):缩进回溯
  域门,无参数/词法域概念;`header_lines` 名行窄化只在**头行**生效,def 体
  结束后的模块行照常扫到体内写点;
- `self_flow.rs` AST 走查 `FunctionDef` 臂(:787-790 修前):只登记
  `header_lines`,**不收集参数、不收集体域、不收集 global/nonlocal 声明**;
- 旧钉 `class_body_write_visible_from_method_body`(批 D)钉住了**错误语义**
  (类体直系写点借给方法体裸名)——账本 SCOPE-04 明文推翻,按账本重钉。

## 修复

1. **词法域表(`self_flow.rs`)**:新 `FnDomain{header_line, start_line,
   end_line, params, globals, nonlocals}`——AST 走查登记**全部 def**(模块/
   方法/嵌套,体域 = 首体行 .. 末体语句末字符行)+ **直接赋值 lambda**
   (`x = lambda p: ...` 自成一域;嵌套于调用/推导式内的 lambda 不入表——
   其体内无裸名写点,越界读按未绑定诚实处理)。参数全量收集
   (位置/仅位置/仅关键字/`*args`/`**kwargs`,注解无关);`global`/
   `nonlocal` 声明收集(控制块内仍归属直接宿主,嵌套 def/class 不下行)。
   类体 `global` 声明另记 `scope_globals`(类名行 → 名)。
2. **域门重铸(`local_return.rs::face_scan`)**:缩进回溯删除,改为
   **Python 名字解析模型**——自 hover 位的**作用域链**(含 hover 行的函数域,
   体首行降序、同首行体更小者先行 = 最内先行;global/nonlocal 域跳过绑定;
   参数绑定 → 诚实空且遮蔽外层)逐域裁定:
   - 域内有该名写点(`method_start` = 本域头行)= **本域局部**(函数级静态
     绑定):hover 行前(含)最近写点 → 解析;写点全在 hover 后 →
     **UnboundLocal 位,诚实空,绝不外借**;
   - 域内无绑定 → 向外层函数域继续;链外尽:
     - 类体直系 hover(不在任何函数域)→ 本类体写点(执行序:绑定而读前
       → NameError 位诚实空;未绑定 → 落模块);他类体写点不借;
     - 方法体 hover 的链**不含类体**(SCOPE-04:类体属性表不在函数词法
       链上);
     - 模块域:非函数域写点;类体直系写点须其类体声明过 `global`;函数域
       内写点须其函数域声明过 `global`(global 写点重定向模块名空间,参与
       模块最近写点裁定——字面量重赋值即诚实空,不回借更早答案)。
3. **旧钉重钉**:批 D `class_body_write_visible_from_method_body` →
   `method_body_does_not_read_class_body_table`(期望 Some(make 注解) →
   None),注明账本推翻旧口径。

## prove-red 与回归

- **修前红 7/7**(干净 HEAD 引擎 + 新用例;stash 源文件后把用例段插回
  HEAD 文件的 tests 模块内复跑):
  `kbug_scope_param_shadow_blocks_module_write`、
  `kbug_scope_vararg_kwonly_kwarg_params_block`、
  `kbug_scope_unbound_local_position_not_borrow_outer`、
  `kbug_scope_lambda_param_shadow_blocks`、`kbug_scope_nested_fn_param_blocks`、
  `kbug_scope_nested_fn_write_not_visible_from_outer`、
  `kbug_scope_def_body_write_not_borrowed_after_def`。
- **守卫例**(修前后同绿,防过度阻断):global 透传读、global 重赋值最近值、
  nonlocal 闭包读、类体直系读本类体、他类体不借、函数内不可解写点即止、
  模块写点对方法体可见(合法外层查询**全部保留**,无删除外层查询过负例)。
- **语义重钉证据**:旧测试 `class_body_write_visible_from_method_body` 在
  HEAD(修前)绿(Tree = 缺陷行为),新引擎下同输入答 None —— 行为翻转
  即 SCOPE-04 缺陷复现与修复;重钉后全绿。
- **修后绿**:kode-python 262(含 local_return 38 例,新 SCOPE 12 例 +
  重钉 1 例)、kode-server 全量 599(含新 `local_return_dispatch.rs` 8 例,
  走完整 `$/kode/rpc` 链路:参数遮蔽/def 体不外溢/global 透传/类体隔离 =
  诚实空,模块读/嵌套闭包读/类体直系读 = 注解命中,非法入参守卫)、
  workspace 1875 全绿。

## 门禁

- Rust:`cargo clippy -p kode-python -p kode-server --all-targets -- -D
  warnings` 0;`cargo test --workspace` 1875 过 0 败。
- TS:`npm run lint` 0;`tsc -p ./` 0;`tsc -p tsconfig.mocha.json` 0;
  `npm run test:unit` 8682 过,2 例红均为已定性既有例:
  `selfAttributeFlowRustParity` fixture 全量例在 `KodeHotReload.py@199`
  (flow 四面 `types:['list']` vs `[]`,hot-reload 车道既有红,与本批无关——
  本批不动 flow 面,失败点与 ROOT 批记录逐字一致)、`hoverDeadlineContext`
  remainingMs 时钟判定(满载抖动族,单跑 10/10 绿);
  `xvfb-run -a npm run test:demo:editor` 25 RC=0。
- pythonLocalReturnTypeRust 7/7(真实 binary 面)。

## 命令

- 单测:`cargo test -p kode-python --lib local_return`
- RPC 例:`cargo test -p kode-server --test local_return_dispatch`
- prove-red 复现:stash 本批两源文件 → 把 `local_return.rs` 尾部
  KBUG-SCOPE 测试段插入 HEAD 文件 tests 模块内 → `cargo test -p
  kode-python --lib local_return`(7 failed)→ 恢复。

## 边界(诚实记录,未建模不硬造)

- `nonlocal` 声明域的写点仍归属写点所在域的表(不重定位到外层函数)——
  外层域最近写点裁定不纳入内层 nonlocal 写点(流不敏感近似;读侧声明
  透传正确);
- 推导式作用域(`[f(x) for x in ...]` 的 `x`)不建模——推导式内无裸名
  写点入表,越界读按未绑定处理(诚实空);
- 嵌套于调用/推导式内的 lambda 不入域表(直接赋值 lambda 入表);
  `global` 声明 + 参数同名的非法语法输入不特判。
