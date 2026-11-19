# RUST-143 批 2:CodeAction provider 装配决策核(code_action_assembly.rs)

2026-11-19。kode2 LSP 族 Rust 收编批第 5 条(批 2 纯库面)。承接批 1
`code_action.rs` 七纯面(注解映射/骨架/插入点/近拼建议/receiver 区间
归属/守卫双编辑/FD 整体重赋),本批在其上装配 TS 生产四 provider 的决策
流(`src/languageProviders/codeAction.ts`):诊断 code 闸 → 区间相交 →
定位面提取 → 去重 → 编辑构造 → 标题/种类/诊断对账,产出 `ActionFace`
纯描述符。

## 交付面

- `crates/kode-server/src/code_action_assembly.rs`:四族装配
  - 修参数类型 = `assemble_type_replacement_actions`(unknown-type
    code 闸 + 真 `find_registered_type_suggestions`)
  - 创建缺失定义 = `assemble_parity_method_actions`(related 定位面 +
    类名兜底 `entity_name_of_def_file` + `collect_method_arg_types` +
    快照插入点 + parity 骨架)
  - 冲突定位 = `assemble_receiver_none_actions`(包裹式首选 + 早退式
    次选 + `${receiver}:${line}` 去重)+ `assemble_fixed_dict_actions`
    (行去重 + 三行习语)
  - 支面:`range_intersects`(line*1_000_000+char 闭区间直比)、
    `text_in_range`(行/列 → 偏移切片)、`map_def_type_to_python_annotation`
    (全表 + Any 兜底)、`build_method_skeleton_with_types`(恒
    `-> None` 返回注解)、`collect_method_arg_types`(client→cell→base
    逆序 = TS DFS-LIFO 标准布局等价序)
- golden `tests/golden/code-action-assembly-parity.json`(4 案例正/负臂
  5 动作,serde tag=type + rename_all_fields camelCase);dump bin。
- 集成测试 3 例:重生成字节比对 + 结构完整性(计数守恒/四族案例齐/
  标题前缀族对账/守卫序钉/负臂计数钉/诊断 code 四常量与 TS 生产同值)
  + TS 镜像 `tests/kodeCodeActionAssemblyParity.test.ts` 4 例:驱动
  **生产 provider 类**(fake-vscode 替身 + mkdtemp 快照盘读 + 临时根
  归一 /w)+ 类型族走真 `findRegisteredTypeSuggestions` 与真
  `diagnosticRangeIntersects`。
- 8 单元钉:闭区间相交/双骨架对照(批 1 免 import 闸 vs parity 全表
  Any 兜底)/区间切片截断/实体名后缀只剥恰好 .def/跨段同名 client 先胜/
  parity 闸序与去重/守卫序与去重/FD 行去重。

## 镜像抓到的真移植缺陷

`buildPythonMethodSkeletonWithTypes` 的骨架签名带恒 `-> None` 返回注解,
Rust 首版漏发 → TS 镜像 deep-equal 红(`def onTalk(self, arg0: int):`
vs `... -> None:`)。按 TS 生产修后重生成 golden,单元钉期望同步加注解。

## 诚实边界(登记,不冒充)

- `KBEngineMethodImplementationCodeActionProvider`(EntityMappingManager
  身份解析/listOwnerScriptFiles 异步服务面)不在本批,其纯半边(骨架/
  插入点)批 1 已收;装配流的服务依赖归接线批。
- Type provider 的 `getKnownTypeContext`(builtins+types.xml+实体装配)
  是 completion 服务面,本面吃 `registered` 显式输入;provider 类级
  行为归 electron 套件(lintQuickFixBoundaries)。
- `collect_method_arg_types` 走 kode_parser 模型(client→cell→base 逆序;
  def 段落非标准文档序时 TS 按文档序 DFS,模型无 span 保序,边界登记);
  属性段同名不命中。
- FD 装配只吃下标存储形态 `self.<attr>[...]=v`(批 1 编辑器正则语义:
  下标段必需,点嵌套赋值不匹配不出);包裹式编辑会吞同目标连续下标行
  (fetch/mutate/store 习语跨行合并,批 1 真语义,golden/镜像双面钉)。
- 标题为 en 源串(l10n 无 bundle 默认);zh bundle 不进对拍;cancel/
  取消位是宿主面,纯函数 N-A。
- parity 装配吃快照文本输入;`readSharedFileSnapshot` 打开文档优先 +
  磁盘补载归接线批。

## prove-red 三靶(cp+cmp 还原,grep 钉复绿)

1. wrap/guard push 顺序交换 → 守卫序钉红。
2. `range_intersects` 边界比较翻转(闭 → 开)→ 闭区间钉红。
3. TS 生产 provider 去重写点(`seen.add(dedupeKey)`)摘除 → 镜像守卫
   例红(3 动作越界)。

## 坑账

- **prove-red 扰动错臂假绿**:首靶翻第一比较(起点 vs 对方终点),但
  端点相触的守门在第二比较(对方起点 vs 己方终点)——扰动必须落在
  被钉语义的实际守门臂上,翻完先核对哪条比较真正决定边界;红不了就
  换臂,不放宽钉。
- **fixture 区间带 `<`**:parity 诊断区间写 `4..10` 把 `<onTalk` 的
  `<` 与截断名 `onTal` 当方法名灌进全链,golden 产出垃圾骨架
  (`def <onTal(self)`)才暴露——诊断区间必须锚定真名 token(生产面
  lint 规则同口径),钉的输入质量决定链路验证质量。
- **serde enum 字段命名**:variant 级 `rename_all = "camelCase"` 只翻
  variant 名,字段仍 snake(`new_text`/`start_line`)→ 加
  `rename_all_fields = "camelCase"`(serde ≥1.0.186)。
- **fake TextEdit.insert 形状**:替身把 insert 编码成零长 Range
  (start==end),镜像归一按「点=插入、行首对齐零列段=整行替换、其余=
  区间替换」三分派回 Rust EditFace。
- TS 临时快照路径会灌进 provider 标题与编辑目标 → 镜像归一
  (tempDir → /w)后在归一域比,fixture 落 `scripts/avatar.py` 对齐
  golden 相关路径。

## 门禁

- `cargo test -p kode-server`:799 lib(含本批 8 钉)+ 98 集成套件全绿
  (本轮全量 ruff 子进程族未复现负载 flake);
- `cargo clippy -p kode-server --all-targets` 0 警告(测试辅助 impl 加
  `#[cfg(test)]`,测试结构体 dead 字段 `#[allow(dead_code)]` 并改消费
  diagnostic 对账行);
- vitest:kodeCodeActionAssemblyParity 4 + kodeDiagnosticLayeringParity
  4 + batch110DefVisuals 10,全绿;
- `pnpm exec tsc --noEmit` rc=0。

## 余界

MethodImplementationProvider 装配(EntityMapping 异步面)、
getKnownTypeContext 输入装配、vscode.Diagnostic/WorkspaceEdit 构造与
l10n bundle、LSP codeAction 接线 —— 均留接线批;todo.md RUST-143 行
保持「部分」。
