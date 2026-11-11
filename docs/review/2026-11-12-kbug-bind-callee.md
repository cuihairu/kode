# KBUG-BIND 调用目标绑定 —— 修复纪实(2026-11-12)

账本:`todo.md` KBUG-BIND 组(审计基线 `10f4b85e`)。缺陷 = localReturnType
面与流面解析被调裸名时**直接查模块声明表**(`local_return.rs` 旧
`face_from_callee` Name 臂:`fp.def_returns.get(f)`;Qualified 臂恒取
`unique_class` 静态命中),调用位置的**名字绑定事实**不参与:参数遮蔽被调
(`def run(make)` 内 `make()` 借模块 def 注解)、局部赋值/局部 def/导入别名
不优先、模块重绑定(`A = B` 后 `A.load()` 仍返回旧 A 注解)。

## 缺陷定位(修前)

- `crates/kode-python/src/local_return.rs`(旧 `face_from_callee` Name 臂):
  无条件 `declared(f)`——被调名被参数/局部绑定遮蔽时照借模块 def 注解;
- Qualified 臂:`unique_class(class)` + 方法原子命中恒先行——`A = B` 重绑定
  后 `A.load(A())` 仍解析旧 A 类表(账本复现例);
- `self_flow.rs` `resolve_callee` Name 臂:同样无条件 `callee_atom(n)`,
  与 localReturnType 面共享同一缺陷(BIND-05);
- 调用先于绑定的 Python 语义(声明提升)`def run(): x = make(); return x`
  与 `make` 声明在文件尾部)本就合法——旧码"歪打正着"命中,但遮蔽场景
  全数误判。

## 修复

1. **绑定事实(`self_flow.rs`)**:新 `CalleeBinding{Unbound, Bound(Option<String>)}`,
   `ResolveState::callee_binding(name, flow_line)` 在调用位解析名字绑定——
   **复用 KBUG-SCOPE 同一作用域链**(含 hover 行的函数域最内先行):
   - 参数/域内直接 def 名 → `Bound(None)`(动态 callable,未知);
   - 域内任意行写点 = 函数级静态绑定 → 取写点值原子:`local_atom(name,
     flow_line)` 返回**身份原子**(唯一类名 / def 名自身,注解由消费方解析);
     读位前有写点 → `Bound(Some(atom))`(别名透传 `fetch = real` → real 的
     注解面);写点全在读位后 → `Unbound`(调用先于绑定,声明仍可用——
     Python 合法语义);
   - `global`/`nonlocal` 声明域跳过绑定(声明表可用);
   - 类体直系步(类体写点/类作用域 def,`A = B` 模块重绑定在此裁定);
   - 模块步:模块写点 3 方裁定(读位前最近写点 → 绑定值;写位后 →
     `Unbound`;`A = B` → 变量链 `resolve_shape(Local("B"))` 解 B 值身份,
     解不出 → `Bound(None)` 未知,**绝不沿用旧注解**)。
2. **流面接线(`self_flow.rs::resolve_callee`)**:Name 臂改绑定驱动——
   `Bound(Some(atom))` → `callee_atom(&atom)`(def 名 → 其注解;类名 →
   实例化原子);`Bound(None)` → None;`Unbound` → 既有 `callee_atom(n)`
   (声明表命中)。
3. **localReturnType 面(`local_return.rs::face_from_callee`)**:Name 臂同
   规则——`Bound(Some(atom))`:类原子 = 实例化语义 `None`(不再借 def 注解),
   否则 `declared(&atom)`;`Bound(None)` → None;`Unbound` → 既有声明表。
   Qualified 臂(BIND-04):静态类命中**仅当** `callee_binding(class) ==
   Unbound`,否则走变量链(绑定值身份 → 唯一类 → 方法原子)——重绑定/
   别名不再任取类表首项,原始类静态方法照常命中。Chained 臂不变。
4. **共享事实(BIND-05)**:两面同走 `ResolveState`(同一 `callee_binding`
   /`local_atom`/作用域链),流类型与 localReturnType 对同一调用位给出
   一致裁定;RPC 分发例双面钉。

## prove-red 与回归

- **修前红 7/10**(干净 HEAD 引擎 + 本批用例;stash 两源文件后把 BIND
  测试段插回 HEAD `local_return.rs` tests 模块内复跑,brace 深度校验,
  恢复后 diff 备份逐字节一致):
  `kbug_bind_param_shadow_blocks_def_annotation`(BIND-01)、
  `kbug_bind_local_rebind_by_assignment_blocks_def_table`、
  `kbug_bind_local_def_shadows_module_def`、
  `kbug_bind_alias_to_annotated_fn_passes_through`(BIND-02)、
  `kbug_bind_module_class_rebind_does_not_keep_old_annotation`、
  `kbug_bind_module_rebind_to_unknown_honest`、
  `kbug_bind_module_name_rebind_blocks_def_annotation`(BIND-03)。
- **守卫例 3 例修前后同绿**:`kbug_bind_unshadowed_call_still_hits`
  (未遮蔽声明命中)、`kbug_bind_call_before_binding_still_declared`
  (调用先于绑定的 Python 合法语义,声明仍可用)、
  `kbug_bind_original_class_qualified_still_hits`(BIND-04 原始类静态命中)。
- **修后绿**:kode-python 272(local_return 48 例,含 SCOPE 12 + BIND 10)、
  kode-server 全量 599 + 新增 `local_return_dispatch.rs` BIND 4 例(12/12,
  走完整 `$/kode/rpc` 链路:参数遮蔽诚实空/未遮蔽命中/`A=B` 重绑定不沿
  旧注解/别名透传命中)、workspace 1889 全绿。

## 门禁

- Rust:`cargo clippy -p kode-python -p kode-server --all-targets -- -D
  warnings` 0;`cargo test --workspace` 1889 过 0 败。
- TS:`npm run lint` 0;`tsc -p ./` 0;`tsc -p tsconfig.mocha.json` 0;
  `npm run test:unit` 8681 过,3 例红均定性:两个超时例
  (`hoverBudget` def-method 层预算/processTopologyPerf Rust RPC 往返)
  **满载抖动族**(全量跑与 cargo workspace 并发挤占,单跑 20/20 绿;
  绑定改动未触及两例超时机制)+ 既知 `selfAttributeFlowRustParity`
  `KodeHotReload.py@199`(hot-reload 车道既有红,失败点与 ROOT/SCOPE 批
  记录逐字一致);
  `xvfb-run -a npm run test:demo:editor` 25 RC=0。
- parity 面隔离复跑:全语料对拍仍仅 `KodeHotReload.py@199` 一处已知红,
  **BIND 改动零新增 parity 分歧**(流面 Name 臂改动未触及任何既有语料
  判定)。

## 命令

- 单测:`cargo test -p kode-python --lib local_return`(48 例)
- RPC 例:`cargo test -p kode-server --test local_return_dispatch`(12 例)
- prove-red 复现:stash `self_flow.rs`+`local_return.rs` → 把 BIND 测试段
  插回 HEAD `local_return.rs` → `cargo test -p kode-python --lib
  local_return`(7 failed)→ 恢复。

## 边界(诚实记录,未建模不硬造)

- 动态 callable(参数遮蔽、重绑定为未知值)恒未知,不因同名声明存在就给
  确定返回类型;
- `local_atom` 只透传**单返回注解 def** 与唯一类名的身份(多返回分支/
  未知值不透传,不硬猜);
- 导入别名(`from x import y as z`)未特判绑定值身份——`z()` 走 `Unbound`
  声明表按 `z` 名命中(既有行为,不改不改错);
- 类体重绑定步的裁定仅覆盖类体直系写点(方法体内 `A = B` 局部重绑定由
  域写点臂覆盖,作用域链同一性保证两面一致)。
