# KSEM-RPC-03 传播引用别名

**日期**:2026-11-13
**条目**:`todo.md` KSEM-RPC-03 [P1]「传播引用别名。验收:peer=self.cell 后保留实体/角色;重绑定、合流和未知接收者不按同名方法猜对象。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| peer=self.cell 后保留实体/角色 | `refs::AliasTable::apply("peer", SelfRole{cell}, face, class)` → `AliasValue::Ref(Remote{class, call})` 原样保留(base 面 self.cell=CELL;cell 面 self.client=CLIENT_VIA_BASE 陷阱同 RPC-02);别名复制(LocalName)与别名取面(LocalHop=已证明链复合)同保真 |
| 重绑定不猜 | 重绑定即遮蔽(`assign` 最近胜):`peer=42` 后查到 `Unknown("字面量赋值:42")`,**绝不回落旧引用**——prove-red 变异(未知重绑定时保留旧值)钉 `rebind_shadows_old_ref` 红咬合 |
| 合流不猜 | `AliasTable::merge`:同名同值 → 保持 Ref;异值 → `Candidates`(分支序,去重保序,消费面不得任取);任一侧 Unknown → Unknown 吞并(候选∪任意=任意,不假装确定);单侧缺 → 另一侧通过 |
| 未知接收者不按同名方法猜 | 未绑定名 → `Unknown("<名>:未绑定,不猜")`;候选取面逐候选 hop:多路异值保持候选、单路成功收敛 Ref、全败/被闸拒 → Unknown(不造调用类型) |

## 2. 模型(纯库面,无 RPC/无 TS 消费)

- `AliasValue{Ref/Candidates/Unknown}`:Unknown 带 reason,三态诚实(确定/多候选/未知),无置信数字;
- `AliasSource{SelfRole/LocalName/LocalHop/NonReference}`:赋值来源归约形态(AST 归类归 BAS-07 expr.rs,消费契约待接线);NonReference(字面量/调用结果/其他)→ Unknown;
- `AliasTable{assign/lookup/apply/merge}`:名字 → 最近绑定;`apply` 组合 self 绑定(RPC-02)/别名复制/别名取面(RPC-01 面跳)/非引用来源四路径;
- 候选 hop 语义:逐候选独立 hop → 收集成功者(去重);恰一 → Ref(收敛),≥2 → Candidates,0 → Unknown——不因部分失败造空/造全。

## 3. 测试纠偏(实现对、测试错两处,按源码改正)

1. 初版 `alias_keeps_entity_and_role` 用 cell 面断言 self.cell=CELL——该面无此属性(cellapp/entity.cpp:74-75 无 `.cell`),改 base 面;
2. 候选 hop 构造两次把 ClientViaBase/CellViaBase 与 BaseViaCell 混淆:`ClientViaBase.base → BaseViaCell`(else 臂,与 `Cell.base` 同值 → 去重);真正的异值对是 `[CELL, CELL_VIA_BASE].base → [BASE_VIA_CELL, BASE]`(后者经 cell 面 self.base→BASE 再 .cell→CELL_VIA_BASE 构造);`BASE_VIA_CELL.base` 自名闸拒(TO 表="base")——面跳矩阵语义(RPC-01)三次复算纠偏,实现零改动。

## 4. 诚实边界

- 语句级 AST 归类(哪个赋值在哪行)归 expr.rs 接线批次;本批是归约后模型,输入是 `AliasSource` 不是源码文本;
- Candidates 消费面(如 RPC-04 落点查找对候选逐个解析并列出多候选)属后续批次;本批保证「消费面不得任取候选当确定对象」这一不变量;
- 别名不跨函数作用域(局部表,无全局逃逸分析);`self` 种子(Local 实体)由消费面按脚本面+实体类给出,类未知保持未知(RPC-02 同口径);
- Unknown 吞并候选是「信息不伪装」的选择:保留候选∪未知=未知,不假装仍确定——与 facts 层「未知不自动转错误」同纪律。

## 5. 证据

- `cargo test -p kode-server --lib semantics::refs` 21/21(RPC-01 七+RPC-02 五+RPC-03 九:保真/重绑定遮蔽/复制+取面/未知不猜/面缺属性 Unknown/同值合流/异值候选/Unknown 吞并+单侧通过/候选 hop 收敛);
- prove-red=变异:未知重绑定保留旧引用(陈旧别名 bug)→ `rebind_shadows_old_ref` 红,恢复 21/21;
- 门禁:clippy 0/cargo test 49 套件全绿;tsc 0/eslint 0/vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0(首跑因无关 workspace C++ 构建打满机器 load 94-131 时序抖动红,负载回落后复跑绿——满载抖动族,与 load~186 clasp 先例同族)。
