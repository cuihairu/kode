# 深审-1 def 解析按引用类别分池

**日期**:2026-11-13
**条目**:`todo.md` Codex 深审发现「给 def 解析按引用类别分池并校验候选类别(`crates/kode-server/src/semantics/store.rs:138`)—— 防同名接口/父实体/组件/实体跨类别串接污染快照。」

## 1. 缺陷面(修复前)

`ProjectDefResolver::resolve(name)` 单池按文件名根解析:同名 `Avatar` 的实体 def 与接口 def 并存时,键序首个胜——解析 Parent「Avatar」可能拿到接口文件,组件类型也可能命中实体文件,**跨类别串接污染快照**;且旧实现无从校验候选类别。

## 2. 引擎真值(逐行核过 ../kbengine)

引擎按类别**分池加载**,同名跨目录不串接:
- 实体:defFilePath(entities 目录)平铺;**Parent 按当前池递归**——实体 parent 在 entities/ 找(`loadParentClass` :907 `defFilePath + parentClassName + ".def"`),组件 parent 在 components/ 找(:774 传 `defFilePath + "components/"`);
- 接口:`<Implements>` 项 → `interfaces/名字.def`(:586);
- 组件:`<Components>` 槽 → `components/名字.def`(:681);
- 接口 def 内还可再 Implements 接口(:618/:628)与带 Components(:613-621)——接口池解析与组件槽恒按各自池。

## 3. 改动面(纯库面,trait 契约升级)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/snapshot.rs` | 新 `ReferenceKind{Entity,Interface,Component}`(类别三池);`DefResolver::resolve` 签名加 kind 参数(池内无此名 → None 诚实缺失,绝不从异类池借候选);`EntitySnapshot::build` 增 `own_kind` 参数——**parent 链按自身类别查池**(引擎 :907/:774 语义),接口恒 Interface、组件槽恒 Component;来源去重 `visited` 改 **(类别, 名) 复合键**(同名父实体与同名接口是两个来源,不互吞);测试替身 DefMap 带类别 + 新增跨池拆分测试 |
| `crates/kode-server/src/semantics/store.rs` | 新 `def_kind_from_key`(路径倒数第二段判池:entities/interfaces/components,根平铺默认 Entity);`ProjectDefResolver::resolve` **类别+名双匹配**;新增判池/跨池不串接测试 |
| `crates/kode-server/src/semantics/cell.rs` | 组件槽展开 resolve 传 Component 池;组件 def 的 `EntitySnapshot::build` 传 `own_kind=Component`(组件 parent 链走组件池——修复前单池碰巧能命中,分池后必须显式);测试 DefMap 适配 |
| `crates/kode-server/src/semantics/query.rs` | EntitySnapshot 查询面按 `def_kind_from_key` 传自身类别 |
| `crates/kode-server/src/semantics/mod.rs` | store 模块文档补深审-1 条目 |

## 4. 测试纠偏(实现缺口,测试抓出)

1. 分池首版 `build` 的 parent 链恒查 Entity 池 → 组件 def 的 parent(WeaponBase,在组件池)查不到,`component_fields_expand_parent_and_interfaces` 红——**测试抓出实现缺口**,build 增 own_kind 组件链走组件池;
2. parent 与 interface 同名(「X」既是父又是接口)时 `visited` 按纯名去重把接口来源吞掉(跨池同名是两个来源)→ 新增 `same_name_across_pools_keeps_parent_and_interface_split` 抓出,visited 改复合键。

## 5. 诚实边界

- 判池按**路径倒数第二段**目录名(引擎目录约定);嵌套子目录(`entities/nested/Sub.def`)按自身段判——嵌套 def 的父引用若真指 `entities/nested/` 下文件,引擎其实也是按 defFilePath 根找(entities/ 根平铺),嵌套目录本身不受引擎支持,本面按默认 Entity 池处理不猜;
- 键序首个(池内同名多文件)语义保留,冲突裁决归快照层 conflicts(分池后池内冲突面收窄,同池同名仍按键序首个+conflicts 记录);
- `types.xml`/alias 池不在本批(TypeGraph 已有独立面);
- RPC 面(`semantics_rpc.rs`)的实体自身查找已传 Entity 池;其余消费面(cellData keys)无新增池需求。

## 6. 证据

- `cargo test -p kode-server --lib semantics::` 257/257(store 新增:def_kind 三目录+根平铺默认/同名跨池 Component 查 None 不借;snapshot 新增:同名父+接口两池拆分零缺失误报;cell 组件 parent 链回归);
- **prove-red = 变异三发全咬合**:(1) resolve 抹池过滤(只按名)→ 1 红(store 跨池不串接);(2) 判池抹 interfaces 段 → 2 红;(3) visited 回退纯名(接口被父链同名吞)→ 1 红;恢复 257/257 且双文件 diff 字节一致;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 FAILED;tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
